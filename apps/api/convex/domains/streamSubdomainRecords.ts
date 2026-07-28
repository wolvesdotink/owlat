/**
 * ONE-PASS DNS generation for the per-stream subdomain layout (P4-7, G-14).
 *
 * The wizard proposes the layout (`streamSubdomains.ts`) and this module emits
 * EVERY record it needs in a single pass — SPF, a per-subdomain DKIM selector
 * and DMARC for each sending subdomain, plus the return-path bundle for the
 * bounce host — so the operator copies one table into their DNS provider once
 * instead of walking a per-subdomain wizard three times.
 *
 * IT REPUBLISHES THE SHIPPED TABLE, IT DOES NOT COMPOSE A SECOND ONE. This is
 * the invariant the module lives or dies on, because the operator sees these
 * rows NEXT TO the ones the domain screen already shows for the same host: two
 * rows labelled SPF with different values is not a wizard, it is a way to break
 * a verified domain. So every From-domain row is built from the SAME input the
 * shipped provider adapter (`providers/mta/index.ts`) uses —
 *   • SPF   ← `MTA_SPF_INCLUDE`, and OMITTED when it is unset, exactly as there;
 *   • DKIM  ← the selector the MTA minted for that host and the record value it
 *             stored, verbatim, or NO row value at all when the host has not
 *             been registered yet;
 *   • DMARC ← the persisted policy and knobs OF THAT HOST'S OWN domain row, not
 *             of whichever domain the operator is looking at — `_dmarc` is a
 *             per-FQDN record and each name enforces what it chose.
 * The pool IPs and the relay terms stay on the RETURN-PATH host, which is the
 * only host `MTA_IP_POOLS` and `MTA_RETURN_PATH_RELAY_SPF` authorise in the
 * shipped code. Record syntax comes from the shipped builders (`spf.ts`,
 * `dmarc.ts`) — a second SPF or DMARC renderer is exactly the kind of duplicate
 * that drifts.
 *
 * IT PUBLISHES THE OPERATOR'S DMARC, NOT A TIGHTER ONE. `sp=` and `pct=` are
 * the knobs `schema/domains.ts` persists alongside `p=`
 * (`dmarcSubdomainPolicy`, `dmarcPct`), and a one-pass generator that dropped
 * them would silently move a domain staged at `pct=10` to full enforcement on
 * 100 % of a stream. Both are threaded through; nothing beyond what the schema
 * stores is invented here.
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
 * Pure — no clock, no db, no env. The SPF include, the pool IPs, the relay
 * terms, the minted selectors and the DMARC policy are all parameters.
 */

import { zoneRelativeHost, type DnsName } from '@owlat/shared/dnsZone';
import { GOVERNED_MESSAGE_TYPES } from '@owlat/shared';
import { buildDmarcRecordValue, type DmarcPolicy } from './dmarc';
import {
	DEFAULT_SPF_QUALIFIER,
	RETURN_PATH_MX_PRIORITY,
	buildReturnPathMailFromRecords,
	buildSpfRecordValue,
	type SpfQualifier,
} from './spf';
import {
	SIGNING_SUBDOMAIN_ROLES,
	STREAM_SUBDOMAIN_ROLES,
	planStreamSubdomains,
	resolveCellSendingIdentity,
	type ArmDkimSelectors,
	type SendingStream,
	type SigningSubdomainPlan,
	type SigningSubdomainRole,
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
 * A DKIM record we can actually publish, or the fact that we cannot yet.
 *
 * `published` carries the selector the MTA MINTED for this host and the record
 * value the shipped generator emitted for it, VERBATIM — the wizard republishes
 * the shipped row, it does not compose a second one. `pending` carries NO VALUE
 * AND NO SELECTOR on purpose: an empty `p=` is not "not filled in yet" (RFC 6376
 * §3.6.1 defines it as a REVOCATION), and a selector we invented is a name
 * nothing in this system signs with. Modelling both as a variant with no fields
 * means the wizard cannot render a copyable value or a fictional selector for a
 * subdomain that has not been added yet, even by accident.
 */
export type StreamSubdomainDkimKey =
	| { status: 'published'; selector: string; value: string }
	| { status: 'pending' };

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
	// The shipped generator's value, verbatim — see StreamSubdomainDkimKey.
	return record.key.status === 'published' ? record.key.value : null;
}

/** The selectors that exist per signing role, indexed for the D11 guard. */
export type SigningSelectorsByRole = Readonly<Record<SigningSubdomainRole, ArmDkimSelectors>>;

export interface StreamSubdomainRecordSet {
	layout: SubdomainLayoutProposal;
	records: StreamSubdomainRecord[];
	/** The selectors these rows were generated from — the guard re-reads them. */
	signingSelectors: SigningSelectorsByRole;
}

/** A domain with no registrable zone renders an explanation, never a stack. */
export type StreamSubdomainRecordResult =
	| { ok: true; recordSet: StreamSubdomainRecordSet }
	| { ok: false; reason: 'invalid_domain' };

/**
 * The DKIM identity the MTA already minted for one proposed host.
 *
 * Both fields come from the SHIPPED registration path — `selector` is
 * `sendingDomainMtaIdentities.dkimSelector` and `recordValue` is the value the
 * provider adapter stored on `domains.dnsRecords.dkim` — so a wizard row built
 * from them is byte-identical to the row the domain screen already shows.
 */
export interface SubdomainSigningIdentity {
	selector: string;
	recordValue: string;
}

/**
 * One host's persisted DMARC configuration.
 *
 * These are exactly the three columns `schema/domains.ts` persists —
 * `dmarcPolicy`, `dmarcSubdomainPolicy` and `dmarcPct` — threaded verbatim,
 * because a generator that dropped `sp=` or `pct=` would silently move a domain
 * staged at `pct=10` to full enforcement on 100 % of a stream. There is no
 * fourth knob to thread: the shipped policy writer (`lifecycle.setDmarcPolicy`)
 * has no alignment setting, so this type carries none either rather than
 * offering an option no production caller can supply. A host that has not been
 * added yet carries `DEFAULT_DMARC_POLICY` — what registration will actually
 * publish for it.
 */
export interface SubdomainDmarcSettings {
	policy: DmarcPolicy;
	subdomainPolicy?: DmarcPolicy;
	pct?: number;
}

export interface StreamSubdomainRecordOptions {
	/**
	 * The DMARC knobs to publish, PER SIGNING ROLE.
	 *
	 * `_dmarc` is a PER-FQDN record and the shipped path builds it from each
	 * domain row's own persisted policy (`lifecycle.setDmarcPolicy`), so one
	 * global set of knobs here would stamp whichever domain the operator happens
	 * to be looking at onto every proposed name — telling them to move a
	 * separately staged `news.` to enforcement it never chose. Same shape as
	 * {@link signingIdentities} for the same reason: these are per-host facts.
	 */
	dmarcByRole: Readonly<Record<SigningSubdomainRole, SubdomainDmarcSettings>>;
	/** Optional `rua=` aggregate-report mailbox. */
	dmarcRua?: string;
	/** SPF trailing qualifier; the shipped default is the soft-fail `~all`. */
	spfQualifier?: SpfQualifier;
	/**
	 * `MTA_SPF_INCLUDE`, verbatim — THE ONE SOURCE OF A FROM-DOMAIN SPF RECORD.
	 *
	 * The shipped provider adapter publishes exactly `v=spf1 include:<this>
	 * <qualifier>` on a sending domain and OMITS the record entirely when the
	 * variable is unset. The wizard does the same thing from the same input, so
	 * the two tables cannot disagree for a host they both cover. It deliberately
	 * does NOT enumerate `MTA_IP_POOLS` here: the pool IPs authorise the RETURN
	 * PATH host, which is where {@link buildReturnPathMailFromRecords} puts them.
	 */
	spfInclude?: string;
	/**
	 * Extra SPF mechanisms authorising a relay/ESP arm (`include:…`), scoped to
	 * the RETURN-PATH HOST — which is the only thing `MTA_RETURN_PATH_RELAY_SPF`
	 * authorises in the shipped code. They never reach a From domain.
	 */
	returnPathRelaySpfTerms?: readonly string[];
	/** The MTA's inbound EHLO host, for the bounce host's MX row. */
	mailHost?: string;
	/**
	 * The DKIM identities that ALREADY EXIST for the proposed hosts, by role. A
	 * role with no entry has not been added as a sending domain yet, so its DKIM
	 * row is pending rather than invented.
	 */
	signingIdentities?: Readonly<Partial<Record<SigningSubdomainRole, SubdomainSigningIdentity>>>;
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

export interface StreamSubdomainRecordInput
	extends SubdomainLayoutInput, StreamSubdomainRecordOptions {}

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
	identity: SubdomainSigningIdentity | undefined;
	referenceArmConfigured: boolean;
}): StreamSubdomainRecord[] {
	// ONE ROW PER DISTINCT NAME. The reference arm's row is worth showing because
	// it is a SECOND selector under the same subdomain — but until the own arm has
	// a minted selector both rows are the bare `_domainkey.<host>` parent with no
	// value, i.e. the identical name printed twice under two labels. That is not
	// the shape, it is doubt: with nothing minted yet the host gets exactly one
	// pending row, and the relay's row appears alongside a real selector.
	const arms: TransportArm[] =
		input.referenceArmConfigured && input.identity !== undefined ? ['own', 'reference'] : ['own'];
	return arms.map((arm): StreamSubdomainRecord => {
		// The reference arm signs with the ESP's key under its own selector, which
		// we never hold; the own arm's is minted once the name is registered.
		const identity = arm === 'own' ? input.identity : undefined;
		// THE SAME SUBDOMAIN FOR BOTH ARMS. Only the selector label differs —
		// which is exactly what D11 permits and all it permits. With no selector
		// yet the row still names the `_domainkey` parent it will live under, so
		// nothing has to invent a label to have a host.
		const host =
			identity === undefined
				? `_domainkey.${input.subdomain.host}`
				: `${identity.selector}._domainkey.${input.subdomain.host}`;
		return {
			subdomain: input.subdomain.host,
			purpose: 'dkim',
			type: 'TXT',
			host,
			relativeHost: zoneRelativeHost(host, input.root),
			arm,
			key:
				identity === undefined
					? { status: 'pending' }
					: { status: 'published', selector: identity.selector, value: identity.recordValue },
		};
	});
}

/**
 * Generate every record for an ALREADY-PLANNED layout in ONE pass.
 *
 * Order is stable and grouped by subdomain (SPF → DKIM → DMARC, then the bounce
 * host's SPF + MX) so the wizard's table and its tests read the same way.
 */
export function buildStreamSubdomainRecords(
	layout: SubdomainLayoutProposal,
	options: StreamSubdomainRecordOptions
): StreamSubdomainRecordSet {
	const root = layout.root;
	const qualifier = options.spfQualifier ?? DEFAULT_SPF_QUALIFIER;
	const relayTerms = options.returnPathRelaySpfTerms ?? [];
	const spfInclude = options.spfInclude;
	const records: StreamSubdomainRecord[] = [];
	const signingSelectors: Record<SigningSubdomainRole, ArmDkimSelectors> = {
		transactional: {},
		bulk: {},
	};

	for (const role of SIGNING_SUBDOMAIN_ROLES) {
		const subdomain = layout.subdomainsByRole[role];
		// Byte-for-byte what the shipped adapter emits for this host, INCLUDING
		// emitting nothing at all when the include is unset.
		if (spfInclude) {
			records.push({
				subdomain: subdomain.host,
				purpose: 'spf',
				type: 'TXT',
				host: subdomain.host,
				relativeHost: subdomain.relativeHost,
				value: buildSpfRecordValue({ include: spfInclude, qualifier }),
			});
		}

		const identity = options.signingIdentities?.[role];
		if (identity !== undefined) signingSelectors[role] = { own: identity.selector };
		records.push(
			...dkimRows({
				subdomain,
				root,
				identity,
				referenceArmConfigured: options.referenceArmConfigured === true,
			})
		);

		// THIS HOST'S OWN policy, never the one the operator happens to be looking
		// at — `_dmarc` is per-FQDN, and a separately registered `news.` publishes
		// the knobs on ITS row (`lifecycle.setDmarcPolicy`), not another domain's.
		const dmarc = options.dmarcByRole[role];
		const dmarcHost = `_dmarc.${subdomain.host}`;
		records.push({
			subdomain: subdomain.host,
			purpose: 'dmarc',
			type: 'TXT',
			host: dmarcHost,
			relativeHost: zoneRelativeHost(dmarcHost, root),
			value: buildDmarcRecordValue(subdomain.host, {
				policy: dmarc.policy,
				...(dmarc.subdomainPolicy === undefined ? {} : { subdomainPolicy: dmarc.subdomainPolicy }),
				...(dmarc.pct === undefined ? {} : { pct: dmarc.pct }),
				...(options.dmarcRua === undefined ? {} : { rua: options.dmarcRua }),
			}),
		});
	}

	// The bounce/VERP host: SPF for the bounce envelope and an MX so remote MTAs
	// can DELIVER the DSN back. It signs nothing and warms nothing, so it gets
	// no DKIM selector and no DMARC row of its own. THIS is where the pool IPs
	// and the relay terms belong — and the only place either appears.
	const bounceRecords =
		buildReturnPathMailFromRecords(
			layout.bounceHost,
			layout.sendingIps,
			qualifier,
			options.mailHost,
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

	return { layout, records, signingSelectors };
}

/** Plan the layout and generate its records in one call (the pure entry point). */
export function generateStreamSubdomainRecords(
	input: StreamSubdomainRecordInput
): StreamSubdomainRecordResult {
	const planned = planStreamSubdomains(input);
	if (!planned.ok) return planned;
	return { ok: true, recordSet: buildStreamSubdomainRecords(planned.proposal, input) };
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
 * stops reading the SAME minted selector — a rotation applied to the identity
 * row but not to the generated table, say.
 *
 * Only arms that actually PUBLISH a selector are checked — a pending row names
 * no selector, and standalone there is no reference row at all. Both absences
 * are supported configurations (D2), not violations.
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
				armSelectors: recordSet.signingSelectors[STREAM_SUBDOMAIN_ROLES[stream]],
			});
			const signsWith = identity.dkimSelector;
			// No selector for this arm yet ⇒ nothing is being signed with a name we
			// failed to publish. That is the standalone / not-yet-added case.
			if (signsWith === null) continue;
			if (!labels.includes(signsWith)) {
				mismatches.push({ stream, arm, host, signsWith, published: [...labels] });
			}
		}
	}
	return mismatches;
}
