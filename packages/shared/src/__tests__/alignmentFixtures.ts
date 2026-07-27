/**
 * Live-DNS fixtures for the dual-transport alignment pre-flight (P3-5).
 *
 * One aligned baseline that every test mutates in exactly one direction, so a
 * failing check is provably the one the test broke and not a side effect of a
 * differently-shaped fixture.
 */

import type {
	AlignmentArm,
	AlignmentDnsFacts,
	AlignmentPreflightInput,
	DnsTxtObservation,
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
		supportsCustomReturnPath: true,
		...overrides,
	};
}

export function relayArm(overrides: Partial<AlignmentArm> = {}): AlignmentArm {
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
		referenceArm: relayArm(),
		dns: alignedDns(),
		checkedAt: CHECKED_AT,
		...overrides,
	};
}
