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
 * D11 — the generated records keep BOTH ARMS OF A CELL on the same From domain
 * and the same `d=`. The only per-arm record is a second DKIM selector under
 * the SAME subdomain; there is no input by which a transport can acquire a
 * subdomain of its own.
 *
 * SINGLE IP IS THE COMMON CASE: with one address both pools authorise that one
 * address and every record still renders. Nothing here requires two IPs.
 *
 * Pure — no clock, no db, no env. Pool IPs, relay terms, selectors and the
 * DMARC policy are all parameters.
 */

import { zoneRelativeHost } from '@owlat/shared/dnsZone';
import { parseIpAddress } from '@owlat/shared/ipAddress';
import { buildDmarcRecordValue, type DmarcPolicy } from './dmarc';
import {
	DEFAULT_SPF_QUALIFIER,
	buildReturnPathMailFromRecords,
	buildSpfRecordValue,
	type SpfQualifier,
} from './spf';
import {
	planStreamSubdomains,
	type SendingSubdomainPlan,
	type SubdomainLayoutInput,
	type SubdomainLayoutProposal,
	type TransportArm,
} from './streamSubdomains';

/** What a generated row is for. The wizard groups its table by this. */
export type StreamSubdomainRecordPurpose = 'spf' | 'dkim' | 'dmarc' | 'mx';

export interface StreamSubdomainRecord {
	/** The subdomain this row belongs to, e.g. `news.example.com`. */
	subdomain: string;
	purpose: StreamSubdomainRecordPurpose;
	type: 'TXT' | 'MX';
	/** Fully-qualified record host. */
	host: string;
	/** The same host relative to the registrable zone, for pasting. */
	relativeHost: string;
	value: string;
	priority?: number;
	/**
	 * Set on a DKIM row whose public key is not known yet (the identity is
	 * created when the domain is registered). The row is still SHOWN — an
	 * operator seeing the full shape up front is the point of a one-pass
	 * table — but the wizard renders it as "value supplied after registration"
	 * rather than as a copyable value.
	 */
	pendingKey?: true;
	/** Present only on DKIM rows: which arm signs with this selector (D11). */
	arm?: TransportArm;
}

export interface StreamSubdomainRecordSet {
	layout: SubdomainLayoutProposal;
	records: StreamSubdomainRecord[];
}

export interface StreamSubdomainRecordInput extends SubdomainLayoutInput {
	/** DMARC policy published on every sending subdomain. */
	dmarcPolicy: DmarcPolicy;
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
	 * comes from the ESP, so the row is always `pendingKey`: the wizard shows
	 * the SHAPE (a second selector under the SAME subdomain) and the operator
	 * pastes the ESP's value. Its absence changes nothing else about the table.
	 */
	referenceArmConfigured?: boolean;
}

const DEFAULT_ARM_SUFFIXES: Record<TransportArm, string> = { own: 'a', reference: 'b' };

/**
 * Drop unparseable addresses instead of throwing.
 *
 * The shipped `buildReturnPathSpfRecord` throws on a bad pool IP, which is
 * right on the registration path (a typo there silently breaks SPF). The wizard
 * is a RENDERING surface: a malformed address must degrade the table, never
 * blow up the screen the operator is using to fix it.
 */
function splitPoolIps(ips: readonly string[] | undefined): { ip4: string[]; ip6: string[] } {
	const ip4: string[] = [];
	const ip6: string[] = [];
	for (const raw of ips ?? []) {
		const parsed = parseIpAddress(raw.trim());
		if (parsed === null) continue;
		if (parsed.family === 'ipv4') ip4.push(parsed.address);
		else ip6.push(parsed.address);
	}
	return { ip4, ip6 };
}

function dkimRows(input: {
	subdomain: SendingSubdomainPlan;
	root: string;
	publicKey: string | undefined;
	suffixes: Record<TransportArm, string>;
	referenceArmConfigured: boolean;
}): StreamSubdomainRecord[] {
	const base = input.subdomain.dkimSelector;
	if (base === null) return [];
	const arms: TransportArm[] = input.referenceArmConfigured ? ['own', 'reference'] : ['own'];
	return arms.map((arm) => {
		const selector = `${base}-${input.suffixes[arm]}`;
		// THE SAME SUBDOMAIN FOR BOTH ARMS. Only the selector label differs —
		// which is exactly what D11 permits and all it permits.
		const host = `${selector}._domainkey.${input.subdomain.host}`;
		// The reference arm signs with the ESP's key, which we never hold.
		const key = arm === 'own' ? input.publicKey : undefined;
		const row: StreamSubdomainRecord = {
			subdomain: input.subdomain.host,
			purpose: 'dkim',
			type: 'TXT',
			host,
			relativeHost: zoneRelativeHost(host, input.root),
			value: key === undefined ? 'v=DKIM1; k=rsa; p=' : `v=DKIM1; k=rsa; p=${key}`,
			arm,
		};
		if (key === undefined) row.pendingKey = true;
		return row;
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
): StreamSubdomainRecordSet {
	const layout = planStreamSubdomains(input);
	const root = layout.root;
	const { ip4, ip6 } = splitPoolIps(input.sendingIps);
	const qualifier = input.spfQualifier ?? DEFAULT_SPF_QUALIFIER;
	const relayTerms = input.relaySpfTerms ?? [];
	const suffixes = input.armSelectorSuffixes ?? DEFAULT_ARM_SUFFIXES;
	const records: StreamSubdomainRecord[] = [];

	for (const subdomain of layout.subdomains) {
		if (!subdomain.sends) continue;

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
		records.push({
			subdomain: layout.bounceHost,
			purpose: record.type === 'MX' ? 'mx' : 'spf',
			type: record.type,
			host: record.hostname,
			relativeHost: zoneRelativeHost(record.hostname, root),
			value: record.value,
			...(record.priority === undefined ? {} : { priority: record.priority }),
		});
	}

	return { layout, records };
}
