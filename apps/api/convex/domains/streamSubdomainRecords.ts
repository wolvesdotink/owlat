/**
 * ONE-PASS DNS generation for the per-stream subdomain layout (P4-7, G-14).
 *
 * The wizard proposes the layout (`streamSubdomains.ts`) and this module emits
 * EVERY record it needs in a single pass — SPF, a per-subdomain DKIM selector
 * and DMARC for each sending subdomain, plus the return-path bundle for the
 * bounce host — so the operator copies one table into their DNS provider once
 * instead of walking a per-subdomain wizard three times.
 *
 * It composes the SHIPPED builders (`spf.ts`, `dmarc.ts`) rather than
 * re-implementing record syntax: a second SPF or DMARC renderer is exactly the
 * kind of duplicate that drifts, and the shipped ones already carry the
 * qualifier handling, the relay-term budget and the RFC 7489 tag ordering.
 *
 * IT PUBLISHES THE OPERATOR'S DMARC, NOT A TIGHTER ONE. `sp=`, `pct=`, `adkim=`
 * and `aspf=` are shipped, persisted settings, and a one-pass generator that
 * dropped them would silently move a domain staged at `pct=10` to full
 * enforcement on 100 % of a stream. Every knob is threaded through.
 *
 * D11 — the generated records keep BOTH ARMS OF A CELL on the same From domain
 * and the same `d=`. The only per-arm record is a second DKIM selector under
 * the SAME subdomain; there is no input by which a transport can acquire a
 * subdomain of its own. {@link findUnpublishedSigningSelectors} closes the one
 * divergence that IS reachable: a selector we sign with that we never published.
 *
 * SINGLE IP IS THE COMMON CASE: with one address both pools authorise that one
 * address and every record still renders. Nothing here requires two IPs.
 *
 * Pure — no clock, no db, no env. Pool IPs, relay terms, selectors and the
 * DMARC policy are all parameters.
 */

import { zoneRelativeHost, type DnsName } from '@owlat/shared/dnsZone';
import { GOVERNED_MESSAGE_TYPES } from '@owlat/shared';
import { buildDmarcRecordValue, type DmarcAlignment, type DmarcPolicy } from './dmarc';
import {
	DEFAULT_SPF_QUALIFIER,
	RETURN_PATH_MX_PRIORITY,
	buildReturnPathMailFromRecords,
	buildSpfRecordValue,
	type SpfQualifier,
} from './spf';
import {
	DEFAULT_ARM_SELECTOR_SUFFIXES,
	armDkimSelector,
	normalizePoolIps,
	planStreamSubdomains,
	resolveCellSendingIdentity,
	type SendingStream,
	type SigningSubdomainPlan,
	type SubdomainLayoutInput,
	type SubdomainLayoutProposal,
	type TransportArm,
} from './streamSubdomains';

/** What a generated row is for. The wizard groups its table by this. */
export type StreamSubdomainRecordPurpose = 'spf' | 'dkim' | 'dmarc' | 'mx';

interface StreamSubdomainRecordBase {
	/** The subdomain this row belongs to, e.g. `news.example.com`. */
	subdomain: string;
	/** Fully-qualified record host. */
	host: string;
	/** The same host relative to the registrable zone, for pasting. */
	relativeHost: string;
}

/**
 * A DKIM public key we hold, or the fact that we do not hold one yet.
 *
 * `pending` carries NO VALUE ON PURPOSE. An empty `p=` is not "not filled in
 * yet": RFC 6376 §3.6.1 defines `p=` with an empty value as THIS KEY HAS BEEN
 * REVOKED. On a one-pass "copy this table into your DNS provider" surface, an
 * empty-`p=` row is a revocation the operator publishes for the very selector
 * they are about to sign with. Modelling the pending state as a variant with no
 * `value` field means the wizard cannot render a copyable value for it even by
 * accident.
 */
export type StreamSubdomainDkimKey = { status: 'published'; value: string } | { status: 'pending' };

/**
 * One generated row. A DISCRIMINATED UNION on `purpose` rather than a bag of
 * optionals: only an MX row has a priority, only a DKIM row has an arm and a
 * key, and only the rows that HAVE a value expose one.
 */
export type StreamSubdomainRecord =
	| (StreamSubdomainRecordBase & { purpose: 'spf'; type: 'TXT'; value: string })
	| (StreamSubdomainRecordBase & { purpose: 'dmarc'; type: 'TXT'; value: string })
	| (StreamSubdomainRecordBase & {
			purpose: 'dkim';
			type: 'TXT';
			/** Which arm signs with this selector (D11). */
			arm: TransportArm;
			key: StreamSubdomainDkimKey;
	  })
	| (StreamSubdomainRecordBase & { purpose: 'mx'; type: 'MX'; value: string; priority: number });

/** The value a row can be copied into a DNS provider with, or `null`. */
export function streamSubdomainRecordValue(record: StreamSubdomainRecord): string | null {
	if (record.purpose !== 'dkim') return record.value;
	return record.key.status === 'published' ? `v=DKIM1; k=rsa; p=${record.key.value}` : null;
}

export interface StreamSubdomainRecordSet {
	layout: SubdomainLayoutProposal;
	records: StreamSubdomainRecord[];
	/** The suffixes these rows were generated with — the guard re-reads them. */
	armSelectorSuffixes: Record<TransportArm, string>;
}

/** A domain with no registrable zone renders an explanation, never a stack. */
export type StreamSubdomainRecordResult =
	| { ok: true; recordSet: StreamSubdomainRecordSet }
	| { ok: false; reason: 'invalid_domain' };

export interface StreamSubdomainRecordInput extends SubdomainLayoutInput {
	/** DMARC policy published on every sending subdomain — the `p=` tag. */
	dmarcPolicy: DmarcPolicy;
	/**
	 * The operator's OTHER shipped DMARC settings. Threaded verbatim: a one-pass
	 * generator that published a stricter record than the operator configured
	 * would enforce on mail they deliberately staged.
	 */
	dmarcSubdomainPolicy?: DmarcPolicy;
	dmarcPct?: number;
	dmarcAdkim?: DmarcAlignment;
	dmarcAspf?: DmarcAlignment;
	/** Optional `rua=` aggregate-report mailbox. */
	dmarcRua?: string;
	/** SPF trailing qualifier; the shipped default is the soft-fail `~all`. */
	spfQualifier?: SpfQualifier;
	/**
	 * Extra SPF mechanisms authorising a relay/ESP arm (`include:…`). They are
	 * added to the SAME record as the pool IPs — one record per host, per RFC
	 * 7208 §3.2 — which is what keeps both arms of a cell SPF-authorised on one
	 * From domain (D11).
	 */
	relaySpfTerms?: readonly string[];
	/** The MTA's inbound EHLO host, for the bounce host's MX row. */
	mailHost?: string;
	/** Known DKIM public keys, keyed by subdomain role. */
	dkimPublicKeys?: { transactional?: string; bulk?: string };
	/**
	 * Per-arm DKIM selector suffixes. Two suffixes ⇒ two selectors UNDER THE
	 * SAME SUBDOMAIN — never two subdomains.
	 */
	armSelectorSuffixes?: Record<TransportArm, string>;
	/**
	 * A reference transport (relay/ESP) is connected.
	 *
	 * D2/D3 — standalone is the DEFAULT and the expected configuration, so the
	 * reference arm's DKIM row is emitted only when one actually exists. Its key
	 * comes from the ESP, so the row is always pending: the wizard shows the
	 * SHAPE (a second selector under the SAME subdomain) and the operator pastes
	 * the ESP's value. Its absence changes nothing else about the table.
	 */
	referenceArmConfigured?: boolean;
}

/** `<selector>._domainkey.<host>` → `<selector>`, or `null` if it is not one. */
export function dkimSelectorLabel(recordHost: string, subdomain: string): string | null {
	const suffix = `._domainkey.${subdomain}`;
	if (!recordHost.endsWith(suffix)) return null;
	const label = recordHost.slice(0, recordHost.length - suffix.length);
	return label === '' ? null : label;
}

function dkimRows(input: {
	subdomain: SigningSubdomainPlan;
	root: DnsName;
	publicKey: string | undefined;
	suffixes: Record<TransportArm, string>;
	referenceArmConfigured: boolean;
}): StreamSubdomainRecord[] {
	const base = input.subdomain.dkimSelectorBase;
	const arms: TransportArm[] = input.referenceArmConfigured ? ['own', 'reference'] : ['own'];
	return arms.map((arm): StreamSubdomainRecord => {
		const selector = armDkimSelector(base, arm, input.suffixes);
		// THE SAME SUBDOMAIN FOR BOTH ARMS. Only the selector label differs —
		// which is exactly what D11 permits and all it permits.
		const host = `${selector}._domainkey.${input.subdomain.host}`;
		// The reference arm signs with the ESP's key, which we never hold.
		const key = arm === 'own' ? input.publicKey : undefined;
		return {
			subdomain: input.subdomain.host,
			purpose: 'dkim',
			type: 'TXT',
			host,
			relativeHost: zoneRelativeHost(host, input.root),
			arm,
			key: key === undefined ? { status: 'pending' } : { status: 'published', value: key },
		};
	});
}

/**
 * Generate every record for the proposed layout in ONE pass.
 *
 * Order is stable and grouped by subdomain (SPF → DKIM → DMARC, then the bounce
 * host's SPF + MX) so the wizard's table and its tests read the same way.
 */
export function generateStreamSubdomainRecords(
	input: StreamSubdomainRecordInput
): StreamSubdomainRecordResult {
	const planned = planStreamSubdomains(input);
	if (!planned.ok) return planned;
	const layout = planned.proposal;
	const root = layout.root;
	const { ip4, ip6 } = normalizePoolIps(input.sendingIps);
	const qualifier = input.spfQualifier ?? DEFAULT_SPF_QUALIFIER;
	const relayTerms = input.relaySpfTerms ?? [];
	const suffixes = input.armSelectorSuffixes ?? DEFAULT_ARM_SELECTOR_SUFFIXES;
	const records: StreamSubdomainRecord[] = [];

	const signing: SigningSubdomainPlan[] = [
		layout.subdomainsByRole.transactional,
		layout.subdomainsByRole.bulk,
	];

	for (const subdomain of signing) {
		records.push({
			subdomain: subdomain.host,
			purpose: 'spf',
			type: 'TXT',
			host: subdomain.host,
			relativeHost: subdomain.relativeHost,
			value: buildSpfRecordValue({ ip4, ip6, extra: relayTerms, qualifier }),
		});

		const publicKey =
			subdomain.role === 'transactional'
				? input.dkimPublicKeys?.transactional
				: input.dkimPublicKeys?.bulk;
		records.push(
			...dkimRows({
				subdomain,
				root,
				publicKey,
				suffixes,
				referenceArmConfigured: input.referenceArmConfigured === true,
			})
		);

		const dmarcHost = `_dmarc.${subdomain.host}`;
		records.push({
			subdomain: subdomain.host,
			purpose: 'dmarc',
			type: 'TXT',
			host: dmarcHost,
			relativeHost: zoneRelativeHost(dmarcHost, root),
			value: buildDmarcRecordValue(subdomain.host, {
				policy: input.dmarcPolicy,
				...(input.dmarcSubdomainPolicy === undefined
					? {}
					: { subdomainPolicy: input.dmarcSubdomainPolicy }),
				...(input.dmarcPct === undefined ? {} : { pct: input.dmarcPct }),
				...(input.dmarcAdkim === undefined ? {} : { adkim: input.dmarcAdkim }),
				...(input.dmarcAspf === undefined ? {} : { aspf: input.dmarcAspf }),
				...(input.dmarcRua === undefined ? {} : { rua: input.dmarcRua }),
			}),
		});
	}

	// The bounce/VERP host: SPF for the bounce envelope and an MX so remote MTAs
	// can DELIVER the DSN back. It signs nothing and warms nothing, so it gets
	// no DKIM selector and no DMARC row of its own.
	const bounceRecords =
		buildReturnPathMailFromRecords(
			layout.bounceHost,
			[...ip4, ...ip6],
			qualifier,
			input.mailHost,
			relayTerms
		) ?? [];
	for (const record of bounceRecords) {
		const shared = {
			subdomain: layout.bounceHost,
			host: record.hostname,
			relativeHost: zoneRelativeHost(record.hostname, root),
			value: record.value,
		};
		const row: StreamSubdomainRecord =
			record.type === 'MX'
				? {
						...shared,
						purpose: 'mx',
						type: 'MX',
						priority: record.priority ?? RETURN_PATH_MX_PRIORITY,
					}
				: { ...shared, purpose: 'spf', type: 'TXT' };
		records.push(row);
	}

	return { ok: true, recordSet: { layout, records, armSelectorSuffixes: suffixes } };
}

// ============ THE D11 GUARDS (both can fail) ============

/** A generated row that gives one arm a name the other arm does not share. */
export interface PerTransportSubdomainViolation {
	/** The record host that is not a shared sending identity. */
	host: string;
	subdomain: string;
	arm: TransportArm;
	/** The From domains a cell of this layout is allowed to use. */
	allowedSendingHosts: string[];
}

/**
 * THE D11 GUARD, over the GENERATED RECORDS.
 *
 * Per-STREAM subdomains are correct; per-TRANSPORT subdomains are forbidden —
 * they split domain reputation, make the two arms incomparable and throw away
 * the reputation the reference arm spent weeks building. So the check is not
 * "do two derivations of the same expression agree" (they always will) but "does
 * any row we would tell the operator to publish put an arm on a host that is not
 * one of the layout's stream From domains". A future edit that gave the own-MTA
 * arm `owlat-mta.example.com` produces rows this reports.
 */
export function findPerTransportSubdomainViolations(
	recordSet: StreamSubdomainRecordSet
): PerTransportSubdomainViolation[] {
	const allowed = new Set<string>(Object.values(recordSet.layout.streamHosts));
	const allowedSendingHosts = [...allowed];
	const violations: PerTransportSubdomainViolation[] = [];
	for (const record of recordSet.records) {
		if (record.purpose !== 'dkim') continue;
		if (allowed.has(record.subdomain)) continue;
		violations.push({
			host: record.host,
			subdomain: record.subdomain,
			arm: record.arm,
			allowedSendingHosts,
		});
	}
	return violations;
}

// ============ THE GUARD THAT CAN FAIL: SIGNED SELECTOR vs PUBLISHED ==========

/** A selector a cell signs with that no generated row publishes. */
export interface UnpublishedSigningSelector {
	stream: SendingStream;
	arm: TransportArm;
	host: string;
	/** What {@link resolveCellSendingIdentity} says that arm signs with. */
	signsWith: string;
	/** The selectors actually published for that arm on that host. */
	published: string[];
}

/**
 * Cross-check the SIGNING side against the PUBLISHING side.
 *
 * D11 permits exactly one difference between the two arms of a cell — the DKIM
 * selector — so the selector is where a divergence is REACHABLE, and it is the
 * expensive kind: mail signed with a selector that has no published TXT record
 * fails DKIM for every message on that subdomain, and nothing in the send path
 * notices. Comparing the two arms' From domains proves nothing (they are
 * derived from the stream alone and cannot differ); comparing what we sign with
 * against what we published can genuinely fail, and does the moment either side
 * grows its own copy of the arm-suffix default.
 *
 * Only arms that actually have a published row are checked — standalone there
 * is no reference row, and its absence is a supported configuration (D2), not a
 * violation.
 */
export function findUnpublishedSigningSelectors(
	recordSet: StreamSubdomainRecordSet
): UnpublishedSigningSelector[] {
	const layout = recordSet.layout;
	const published = new Map<string, string[]>();
	for (const record of recordSet.records) {
		if (record.purpose !== 'dkim') continue;
		const label = dkimSelectorLabel(record.host, record.subdomain);
		if (label === null) continue;
		const key = `${record.subdomain}|${record.arm}`;
		const labels = published.get(key);
		if (labels === undefined) published.set(key, [label]);
		else labels.push(label);
	}

	const mismatches: UnpublishedSigningSelector[] = [];
	for (const stream of GOVERNED_MESSAGE_TYPES) {
		const host = layout.streamHosts[stream];
		for (const arm of ['own', 'reference'] as const) {
			const labels = published.get(`${host}|${arm}`);
			if (labels === undefined) continue;
			const identity = resolveCellSendingIdentity({
				layout,
				stream,
				arm,
				armSelectorSuffix: recordSet.armSelectorSuffixes,
			});
			if (!labels.includes(identity.dkimSelector)) {
				mismatches.push({
					stream,
					arm,
					host,
					signsWith: identity.dkimSelector,
					published: [...labels],
				});
			}
		}
	}
	return mismatches;
}
