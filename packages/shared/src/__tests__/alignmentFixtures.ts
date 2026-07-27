/**
 * Live-DNS fixtures for the dual-transport alignment pre-flight (P3-5).
 *
 * One aligned baseline that every case mutates in exactly one direction, so a
 * failing check is provably the one the case broke and not a side effect of a
 * differently-shaped fixture.
 *
 * The failure table below is the SHARED four-check table: `alignmentPreflight`
 * runs it with a reference arm and asserts each failure and its remedy;
 * `alignmentSingleArm` re-runs THE SAME TABLE with `reference: { kind: 'none' }`
 * and asserts every single row passes anyway. That is the D2 proof — not three
 * hand-written cases that could drift from the real table.
 */

import type {
	AlignmentArm,
	AlignmentCheckId,
	AlignmentDnsFacts,
	AlignmentPreflightInput,
	DnsTxtObservation,
	ReferenceAlignmentArm,
} from '../deliverabilityAlignment';

export const CHECKED_AT = 1_800_000_000_000;

export const DKIM_KEY = 'v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQ';
export const DMARC_RECORD = 'v=DMARC1; p=quarantine; rua=mailto:dmarc@acme.com';
export const OWN_SPF_MECHANISM = 'ip4:203.0.113.10';
export const RELAY_SPF_MECHANISM = 'include:amazonses.com';
export const PUBLISHED_SPF = `v=spf1 ${OWN_SPF_MECHANISM} ${RELAY_SPF_MECHANISM} ~all`;

export function ownArm(overrides: Partial<AlignmentArm> = {}): AlignmentArm {
	return {
		label: 'own MTA',
		fromDomain: 'acme.com',
		dkimDomain: 'acme.com',
		dkimSelectors: ['owlat'],
		spfMechanisms: [OWN_SPF_MECHANISM],
		...overrides,
	};
}

export function relayArm(overrides: Partial<ReferenceAlignmentArm> = {}): ReferenceAlignmentArm {
	return {
		label: 'SES relay',
		fromDomain: 'acme.com',
		dkimDomain: 'acme.com',
		dkimSelectors: ['ses-token-1'],
		spfMechanisms: [RELAY_SPF_MECHANISM],
		supportsCustomReturnPath: true,
		...overrides,
	};
}

export function found(...records: string[]): DnsTxtObservation {
	return { state: 'found', records };
}

export function alignedDns(overrides: Partial<AlignmentDnsFacts> = {}): AlignmentDnsFacts {
	return {
		fromDomainTxt: found(PUBLISHED_SPF),
		dmarcTxt: found(DMARC_RECORD),
		dkimTxt: {
			'owlat._domainkey.acme.com': found(DKIM_KEY),
			'ses-token-1._domainkey.acme.com': found(DKIM_KEY),
		},
		...overrides,
	};
}

/** The aligned baseline: two arms, everything published, nothing to remedy. */
export function alignedInput(
	overrides: Partial<AlignmentPreflightInput> = {}
): AlignmentPreflightInput {
	return {
		ownArm: ownArm(),
		reference: { kind: 'arm', arm: relayArm() },
		dns: alignedDns(),
		checkedAt: CHECKED_AT,
		...overrides,
	};
}

/** One row of the four-check table: one baseline mutation, one expected verdict. */
export interface AlignmentFailureCase {
	name: string;
	/** The check this mutation must break — and ONLY this one. */
	check: AlignmentCheckId;
	/** `unknown` is a hold, never a fail: DNS that could not answer. */
	expected: 'fail' | 'unknown';
	/** Substring the operator-facing detail must carry. */
	detail: string;
	/** Substring the remedy must carry, so the copy is pinned per failure. */
	remedy: string;
	mutate: (input: AlignmentPreflightInput) => AlignmentPreflightInput;
}

/** A record that needs 11 DNS lookups once the relay's include is merged in. */
export const OVER_LIMIT_SPF = [
	'v=spf1',
	OWN_SPF_MECHANISM,
	'include:a.example',
	'include:b.example',
	'include:c.example',
	'include:d.example',
	'include:e.example',
	'include:f.example',
	'include:g.example',
	'include:h.example',
	'include:i.example',
	'include:j.example',
	'~all',
].join(' ');

export const ALIGNMENT_FAILURE_TABLE: readonly AlignmentFailureCase[] = [
	{
		name: 'the own arm sends from its own subdomain',
		check: 'from_domain',
		expected: 'fail',
		detail: 'mail.acme.com',
		remedy: 'Per-transport subdomains split domain reputation',
		mutate: (input) => ({
			...input,
			ownArm: ownArm({ fromDomain: 'mail.acme.com', dkimDomain: 'mail.acme.com' }),
		}),
	},
	{
		name: 'no SPF record is published',
		check: 'spf',
		expected: 'fail',
		detail: 'No v=spf1 record is published',
		remedy: 'Publish one v=spf1 TXT record',
		mutate: (input) => ({ ...input, dns: alignedDns({ fromDomainTxt: { state: 'absent' } }) }),
	},
	{
		name: 'two SPF records are published',
		check: 'spf',
		expected: 'fail',
		detail: '2 v=spf1 records',
		remedy: 'Remove the extra v=spf1 TXT record',
		mutate: (input) => ({
			...input,
			dns: alignedDns({ fromDomainTxt: found(PUBLISHED_SPF, 'v=spf1 include:other.example ~all') }),
		}),
	},
	{
		name: "the published record omits the relay's include",
		check: 'spf',
		expected: 'fail',
		detail: RELAY_SPF_MECHANISM,
		remedy: 'Add the missing mechanism',
		mutate: (input) => ({
			...input,
			dns: alignedDns({ fromDomainTxt: found(`v=spf1 ${OWN_SPF_MECHANISM} ~all`) }),
		}),
	},
	{
		// A negative qualifier MATCHES the same sources and costs the same DNS
		// lookup, but it authorizes nothing: this record SPF-fails both arms. Reading
		// the qualifier-stripped token as "present" would start the ramp on it.
		name: 'the published record names both arms under a negative qualifier',
		check: 'spf',
		expected: 'fail',
		detail: OWN_SPF_MECHANISM,
		remedy: 'Add the missing mechanism',
		mutate: (input) => ({
			...input,
			dns: alignedDns({
				fromDomainTxt: found(`v=spf1 -${OWN_SPF_MECHANISM} ~${RELAY_SPF_MECHANISM} ~all`),
			}),
		}),
	},
	{
		name: 'merging the relay include pushes the record past 10 lookups',
		check: 'spf',
		expected: 'fail',
		detail: 'DNS lookups; RFC 7208 allows 10',
		remedy: 'Flatten include:j.example',
		mutate: (input) => ({
			...input,
			dns: alignedDns({ fromDomainTxt: found(OVER_LIMIT_SPF) }),
		}),
	},
	{
		name: "the own arm's SPF mechanisms are not known",
		check: 'spf',
		expected: 'unknown',
		detail: 'are not known',
		remedy: 'Set MTA_IP_POOLS',
		mutate: (input) => ({ ...input, ownArm: ownArm({ spfMechanisms: [] }) }),
	},
	{
		name: 'the own arm publishes no DKIM key',
		check: 'dkim',
		expected: 'fail',
		detail: 'publishes no DKIM key',
		remedy: 'Publish the DKIM public key',
		mutate: (input) => ({
			...input,
			dns: alignedDns({
				dkimTxt: {
					// An AUTHORITATIVE absence — NXDOMAIN, not an unresolved lookup.
					'owlat._domainkey.acme.com': { state: 'absent' },
					'ses-token-1._domainkey.acme.com': found(DKIM_KEY),
				},
			}),
		}),
	},
	{
		name: 'the own arm signs with a different d=',
		check: 'dkim',
		expected: 'fail',
		detail: 'd=mail.acme.com',
		remedy: 'Sign both arms with the same DKIM d= domain',
		mutate: (input) => ({ ...input, ownArm: ownArm({ dkimDomain: 'mail.acme.com' }) }),
	},
	{
		name: 'both arms share one selector',
		check: 'dkim',
		expected: 'fail',
		detail: 'same selector',
		remedy: 'Give each arm its own DKIM selector',
		mutate: (input) => ({
			...input,
			reference: { kind: 'arm', arm: relayArm({ dkimSelectors: ['owlat'] }) },
		}),
	},
	{
		name: 'the DKIM key is revoked',
		check: 'dkim',
		expected: 'fail',
		detail: 'revoked',
		remedy: 'Republish the public key',
		mutate: (input) => ({
			...input,
			dns: alignedDns({
				dkimTxt: {
					'owlat._domainkey.acme.com': found('v=DKIM1; k=rsa; p='),
					'ses-token-1._domainkey.acme.com': found(DKIM_KEY),
				},
			}),
		}),
	},
	{
		name: 'no DMARC record is published',
		check: 'dmarc',
		expected: 'fail',
		detail: 'No DMARC record',
		remedy: 'Publish a _dmarc TXT record',
		mutate: (input) => ({ ...input, dns: alignedDns({ dmarcTxt: { state: 'absent' } }) }),
	},
	{
		name: 'two DMARC records are published',
		check: 'dmarc',
		expected: 'fail',
		detail: '2 DMARC records',
		remedy: 'Remove the extra _dmarc TXT record',
		mutate: (input) => ({
			...input,
			dns: alignedDns({ dmarcTxt: found(DMARC_RECORD, 'v=DMARC1; p=none') }),
		}),
	},
	{
		name: 'adkim=s is published and an arm signs a subdomain',
		check: 'dmarc',
		expected: 'fail',
		detail: 'adkim=s requires d=',
		remedy: 'every arm must sign with d= exactly equal to the From domain',
		mutate: (input) => ({
			...input,
			reference: {
				kind: 'arm',
				arm: relayArm({ dkimDomain: 'sub.acme.com', dkimSelectors: ['ses-token-1'] }),
			},
			dns: alignedDns({
				dmarcTxt: found('v=DMARC1; p=reject; adkim=s'),
				dkimTxt: {
					'owlat._domainkey.acme.com': found(DKIM_KEY),
					'ses-token-1._domainkey.sub.acme.com': found(DKIM_KEY),
				},
			}),
		}),
	},
	{
		name: 'the SPF lookup times out',
		check: 'spf',
		expected: 'unknown',
		detail: 'returned timeout',
		remedy: 'DNS could not be resolved',
		mutate: (input) => ({
			...input,
			dns: alignedDns({ fromDomainTxt: { state: 'unknown', failure: 'timeout' } }),
		}),
	},
	{
		name: 'the DMARC lookup SERVFAILs',
		check: 'dmarc',
		expected: 'unknown',
		detail: 'returned servfail',
		remedy: 'DNS could not be resolved',
		mutate: (input) => ({
			...input,
			dns: alignedDns({ dmarcTxt: { state: 'unknown', failure: 'servfail' } }),
		}),
	},
	{
		name: 'a DKIM lookup is REFUSED',
		check: 'dkim',
		expected: 'unknown',
		detail: 'could not be resolved',
		remedy: 'DNS could not be resolved',
		mutate: (input) => ({
			...input,
			dns: alignedDns({
				dkimTxt: {
					'owlat._domainkey.acme.com': { state: 'unknown', failure: 'refused' },
					'ses-token-1._domainkey.acme.com': found(DKIM_KEY),
				},
			}),
		}),
	},
];
