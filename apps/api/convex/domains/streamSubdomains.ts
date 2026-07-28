/**
 * Per-STREAM sending subdomains — the layout the domain wizard proposes by
 * default (P4-7, plan gap G-14).
 *
 * WHY THIS EXISTS. Domain reputation is evaluated PER FQDN and does NOT
 * inherit from the registrable root, so a bad campaign on `example.com` drags
 * password resets down with it. Separating `news.` from `mail.` is industry
 * standard, and until this piece the wizard neither offered nor encouraged it.
 * The layout is therefore the DEFAULT PROPOSAL, not an expert toggle.
 *
 * THE LAYOUT (the plan's table, verbatim):
 *   transactional        → mail.<root>      (transactional pool)
 *   marketing/campaigns  → news.<root>      (campaign pool)
 *   automation/lifecycle → news.<root>      (campaign pool — steady lifecycle
 *                                            volume is the best warming fuel)
 *   bounce/VERP          → bounces.<root>   (already the MTA's return-path host)
 *
 * D11 — PER-STREAM IS CORRECT, PER-TRANSPORT IS FORBIDDEN. This is the piece
 * most likely to violate it, so the violation is not expressible: nothing in
 * this module takes a transport, a provider id or an arm as an input to the
 * From domain or the DKIM `d=`. {@link resolveCellSendingIdentity} takes an arm
 * ONLY to name that arm's DKIM SELECTOR — the one thing D11 explicitly allows
 * to differ — and {@link findPerTransportSubdomainViolations} re-derives both
 * arms and asserts they agree.
 *
 * SINGLE-IP DEPLOYMENTS ARE THE COMMON CASE. Most self-hosters have exactly one
 * IP, so the transactional and campaign pools resolve to the same address and
 * pool separation collapses. Nothing here assumes otherwise: the layout, the
 * records and the advice are all correct with one IP, and the subdomain split
 * still delivers the reputation isolation because DOMAIN reputation is what is
 * doing the work.
 *
 * Pure: no clock, no db, no env — every input is a parameter.
 */

import { asDnsName, trySplitZone, zoneRelativeHost, type DnsName } from '@owlat/shared/dnsZone';
import { parseIpAddress } from '@owlat/shared/ipAddress';
import {
	GOVERNED_MESSAGE_TYPES,
	type GovernedIpPool,
	type GovernedMessageType,
} from '@owlat/shared';

/** The stream axis of a ramp cell — the shipped governed message types (D6). */
export type SendingStream = GovernedMessageType;

/** What a subdomain in the proposed layout is FOR. */
export type SendingSubdomainRole = 'transactional' | 'bulk' | 'bounce';

/** The label each role takes under the registrable root. */
export const STREAM_SUBDOMAIN_LABELS = {
	transactional: 'mail',
	bulk: 'news',
	bounce: 'bounces',
} as const satisfies Record<SendingSubdomainRole, string>;

/**
 * Stream → role. `automation` deliberately shares the bulk subdomain with
 * `campaign`: lifecycle mail is steady, well-engaged volume and is the best
 * warming fuel a bulk subdomain can get, so splitting it off would leave two
 * thin reputations instead of one healthy one.
 */
export const STREAM_SUBDOMAIN_ROLES = {
	transactional: 'transactional',
	campaign: 'bulk',
	automation: 'bulk',
} as const satisfies Record<SendingStream, Exclude<SendingSubdomainRole, 'bounce'>>;

/** The IP pool a role sends from. The bounce host does not send. */
export const SUBDOMAIN_ROLE_POOLS = {
	transactional: 'transactional',
	bulk: 'campaign',
} as const satisfies Record<Exclude<SendingSubdomainRole, 'bounce'>, GovernedIpPool>;

/**
 * Advice the wizard renders IN THE WIZARD, not in the docs. Stable keys so the
 * UI owns the wording and the tests pin the decision rather than a sentence.
 */
export type SubdomainAdviceKey =
	| 'no_reputation_inheritance'
	| 'each_subdomain_warms_separately'
	| 'automation_shares_the_bulk_subdomain'
	| 'pools_separated'
	| 'pools_collapsed_single_ip'
	| 'bounce_host_is_the_return_path';

export const SUBDOMAIN_ADVICE_COPY: Record<SubdomainAdviceKey, string> = {
	no_reputation_inheritance:
		'A subdomain does not inherit the root domain’s reputation. Each sending subdomain needs its own SPF record, its own DKIM selector and its own warm-up.',
	each_subdomain_warms_separately:
		'Each sending subdomain starts its warm-up from day one — reputation is earned per name, not handed down.',
	automation_shares_the_bulk_subdomain:
		'Lifecycle and campaign mail share news. on purpose: steady automation volume is the best warming fuel a bulk subdomain can get.',
	pools_separated:
		'Transactional mail sends from its own IP pool, so a bad campaign can never delay a password reset.',
	pools_collapsed_single_ip:
		'This deployment has one sending IP, so the transactional and campaign pools are the same address. The subdomain split still gives you the isolation that matters — domain reputation is doing the work here.',
	bounce_host_is_the_return_path:
		'bounces. is the return-path (VERP) host. It carries SPF for the bounce envelope and never sends mail of its own, so it does not need DKIM or a warm-up.',
};

/** One subdomain in the proposal. */
export interface SendingSubdomainPlan {
	role: SendingSubdomainRole;
	label: string;
	/** Fully-qualified host, e.g. `news.example.com`. */
	host: DnsName;
	/** The same host written relative to the registrable zone, e.g. `news`. */
	relativeHost: string;
	/** Streams that send from this host. Empty for the bounce host. */
	streams: SendingStream[];
	/** The IP pool this host sends from; `null` for the non-sending bounce host. */
	pool: GovernedIpPool | null;
	/** False only for the bounce host. */
	sends: boolean;
	/**
	 * The BASE of this host's DKIM selectors — never a selector that is published
	 * or signed with. The real selector is `${base}-${armSuffix}`
	 * ({@link DEFAULT_ARM_SELECTOR_SUFFIXES}), because the two arms of a cell sign
	 * with different keys under the SAME `d=` (D11). Signing with the base alone
	 * would use a selector that has no DNS record. The base is never shared with
	 * another subdomain: one rotation must not touch two reputations.
	 */
	dkimSelectorBase: string | null;
}

/** A role that SENDS: it always has an IP pool and a DKIM selector base. */
export type SigningSubdomainPlan = SendingSubdomainPlan & {
	sends: true;
	pool: GovernedIpPool;
	dkimSelectorBase: string;
};

/** The return-path host: it signs nothing and warms nothing. */
export type BounceSubdomainPlan = SendingSubdomainPlan & {
	sends: false;
	pool: null;
	dkimSelectorBase: null;
};

/**
 * The plans indexed by role. The layout knows the role → plan mapping TOTALLY,
 * so a consumer never scans the list and never invents a fallback for a role
 * that cannot be missing — and the per-role types make "the bounce host has no
 * selector" a fact of the type rather than a `null` every caller re-checks.
 */
export interface SubdomainsByRole {
	transactional: SigningSubdomainPlan;
	bulk: SigningSubdomainPlan;
	bounce: BounceSubdomainPlan;
}

export interface SubdomainLayoutProposal {
	root: DnsName;
	subdomains: SendingSubdomainPlan[];
	subdomainsByRole: SubdomainsByRole;
	/** Stream → the host it sends from. The wizard's headline table. */
	streamHosts: Record<SendingStream, DnsName>;
	/** The return-path host every stream shares. */
	bounceHost: DnsName;
	/** True when both pools resolve to the same single IP — the common case. */
	poolsCollapsed: boolean;
	advice: SubdomainAdviceKey[];
}

/**
 * Per-subdomain DKIM selectors.
 *
 * Each sending subdomain gets its OWN selector because each is its own signing
 * identity: reusing one selector across `mail.` and `news.` means one key
 * rotation touches both reputations at once and one leaked key compromises
 * both. Callers pass explicit selectors when they already have identity rows;
 * otherwise the default derives a stable, distinct selector per role from a
 * caller-supplied base (never from a clock — this module is pure).
 */
export interface SubdomainDkimSelectors {
	transactional: string;
	bulk: string;
}

/**
 * Derive per-role selectors from one base, e.g. the domain's existing
 * `sendingDomainMtaIdentities.dkimSelector`.
 */
export function deriveSubdomainDkimSelectors(base: string): SubdomainDkimSelectors {
	const trimmed = base.trim().toLowerCase();
	const root = trimmed === '' ? 'owlat' : trimmed;
	return { transactional: `${root}-mail`, bulk: `${root}-news` };
}

export interface SubdomainLayoutInput {
	/** Any host under the operator's zone; the registrable root is derived. */
	domain: string;
	/**
	 * The deployment's sending IPs. ONE IP is the common case and is fully
	 * supported — the pools simply collapse onto it. An empty list is also fine
	 * (a relay-only deployment); it collapses the same way.
	 */
	sendingIps?: readonly string[];
	dkimSelectors?: SubdomainDkimSelectors;
	/** Base for {@link deriveSubdomainDkimSelectors} when selectors are not given. */
	dkimSelectorBase?: string;
}

/** Pool IPs, parsed once and read the same way by every consumer. */
export interface NormalizedPoolIps {
	ip4: string[];
	ip6: string[];
	/** Distinct addresses across both families — what "one IP" actually means. */
	distinctCount: number;
}

/**
 * Parse, normalise and DE-DUPE the deployment's sending IPs.
 *
 * ONE helper because the two things a caller does with this list — "are the
 * pools collapsed?" and "what goes in the SPF record?" — must agree. De-duping
 * on the raw string while the SPF builder normalises would let
 * `2001:DB8::1` and `2001:db8::1` read as two pools AND emit the same `ip6:`
 * term twice; de-duping on the NORMALISED address is the only answer that is
 * right on both counts (the same goes for a zero-padded IPv4 form).
 *
 * Unparseable entries are dropped rather than thrown on: the wizard is a
 * RENDERING surface and a typo must degrade the table, never blow up the screen
 * the operator is using to fix it.
 */
export function normalizePoolIps(ips: readonly string[] | undefined): NormalizedPoolIps {
	const ip4: string[] = [];
	const ip6: string[] = [];
	const seen = new Set<string>();
	for (const raw of ips ?? []) {
		const parsed = parseIpAddress(raw.trim());
		if (parsed === null) continue;
		if (seen.has(parsed.address)) continue;
		seen.add(parsed.address);
		if (parsed.family === 'ipv4') ip4.push(parsed.address);
		else ip6.push(parsed.address);
	}
	return { ip4, ip6, distinctCount: seen.size };
}

/** A domain with no registrable zone renders an explanation, never a stack. */
export type SubdomainLayoutResult =
	| { ok: true; proposal: SubdomainLayoutProposal }
	| { ok: false; reason: 'invalid_domain' };

/**
 * Build the proposed layout for a domain. This is what the wizard shows FIRST —
 * the plan's layout is the default, not an option behind a toggle.
 *
 * Returns a RESULT rather than throwing: `localhost`, an internal TLD or a typo
 * has no registrable zone, and the wizard must say so in place of the table
 * instead of taking the screen down.
 */
export function planStreamSubdomains(input: SubdomainLayoutInput): SubdomainLayoutResult {
	const zone = trySplitZone(input.domain);
	if (zone === null) return { ok: false, reason: 'invalid_domain' };
	const root = zone.registrable;
	// One distinct address (or none) means the two pools are the same address.
	// That is the COMMON case for a self-hoster, not a degraded one.
	const poolsCollapsed = normalizePoolIps(input.sendingIps).distinctCount < 2;

	const selectors =
		input.dkimSelectors ?? deriveSubdomainDkimSelectors(input.dkimSelectorBase ?? 'owlat');

	// The brand exists so downstream pieces cannot fabricate a DnsName, so the
	// hosts go through `asDnsName` rather than a cast. A label that will not name
	// (a root long enough to blow the 253-octet limit, say) degrades the whole
	// table the same way an unusable zone does — still no throw.
	const transactionalHost = asDnsName(`${STREAM_SUBDOMAIN_LABELS.transactional}.${root}`);
	const bulkHost = asDnsName(`${STREAM_SUBDOMAIN_LABELS.bulk}.${root}`);
	const bounceHost = asDnsName(`${STREAM_SUBDOMAIN_LABELS.bounce}.${root}`);
	if (transactionalHost === null || bulkHost === null || bounceHost === null) {
		return { ok: false, reason: 'invalid_domain' };
	}

	const relative = (host: DnsName): string => zoneRelativeHost(host, root);

	const streamsFor = (role: SendingSubdomainRole): SendingStream[] =>
		GOVERNED_MESSAGE_TYPES.filter((stream) => STREAM_SUBDOMAIN_ROLES[stream] === role);

	const subdomainsByRole: SubdomainsByRole = {
		transactional: {
			role: 'transactional',
			label: STREAM_SUBDOMAIN_LABELS.transactional,
			host: transactionalHost,
			relativeHost: relative(transactionalHost),
			streams: streamsFor('transactional'),
			pool: SUBDOMAIN_ROLE_POOLS.transactional,
			sends: true,
			dkimSelectorBase: selectors.transactional,
		},
		bulk: {
			role: 'bulk',
			label: STREAM_SUBDOMAIN_LABELS.bulk,
			host: bulkHost,
			relativeHost: relative(bulkHost),
			streams: streamsFor('bulk'),
			pool: SUBDOMAIN_ROLE_POOLS.bulk,
			sends: true,
			dkimSelectorBase: selectors.bulk,
		},
		bounce: {
			role: 'bounce',
			label: STREAM_SUBDOMAIN_LABELS.bounce,
			host: bounceHost,
			relativeHost: relative(bounceHost),
			streams: [],
			pool: null,
			sends: false,
			dkimSelectorBase: null,
		},
	};
	// Stable order: the two sending hosts first, the return path last — the order
	// the wizard's table reads in.
	const subdomains: SendingSubdomainPlan[] = [
		subdomainsByRole.transactional,
		subdomainsByRole.bulk,
		subdomainsByRole.bounce,
	];

	const streamHosts = {
		transactional: transactionalHost,
		campaign: bulkHost,
		automation: bulkHost,
	} satisfies Record<SendingStream, DnsName>;

	const advice: SubdomainAdviceKey[] = [
		'no_reputation_inheritance',
		'each_subdomain_warms_separately',
		'automation_shares_the_bulk_subdomain',
		poolsCollapsed ? 'pools_collapsed_single_ip' : 'pools_separated',
		'bounce_host_is_the_return_path',
	];

	return {
		ok: true,
		proposal: {
			root,
			subdomains,
			subdomainsByRole,
			streamHosts,
			bounceHost,
			poolsCollapsed,
			advice,
		},
	};
}

// ============ D11: ONE SENDING IDENTITY PER CELL, WHICHEVER ARM CARRIES IT ====

/** The two arms of a ramp cell. Only the DKIM SELECTOR may differ between them. */
export type TransportArm = 'own' | 'reference';

/**
 * The suffix each arm's DKIM selector carries under the SAME subdomain.
 *
 * ONE declaration, consumed by BOTH the signing side
 * ({@link resolveCellSendingIdentity}) and the publishing side
 * (`streamSubdomainRecords.dkimRows`). Two copies of this default is a silent
 * DKIM outage waiting to happen: mail signed with a selector that has no
 * published TXT record fails DKIM for every message on that subdomain, and
 * nothing in the send path notices.
 */
export const DEFAULT_ARM_SELECTOR_SUFFIXES: Record<TransportArm, string> = {
	own: 'a',
	reference: 'b',
};

/** The full selector an arm signs with under a subdomain's selector base. */
export function armDkimSelector(
	base: string,
	arm: TransportArm,
	suffixes: Record<TransportArm, string> = DEFAULT_ARM_SELECTOR_SUFFIXES
): string {
	return `${base}-${suffixes[arm]}`;
}

export interface CellSendingIdentity {
	stream: SendingStream;
	arm: TransportArm;
	/** The From domain. Derived from the STREAM alone. */
	fromDomain: DnsName;
	/** The DKIM `d=`. Always the From domain — alignment is not optional. */
	dkimDomain: DnsName;
	/** The return-path host. Shared by every stream and both arms. */
	returnPathDomain: DnsName;
	/**
	 * The ONE thing D11 allows to differ per arm: each transport signs with its
	 * own key under the SAME `d=`, so `Received` headers and the selector are
	 * the only observable difference between the arms.
	 */
	dkimSelector: string;
}

/**
 * Resolve a cell's sending identity.
 *
 * `arm` reaches exactly one field — the selector. There is no code path by
 * which a transport can influence `fromDomain`, `dkimDomain` or
 * `returnPathDomain`, which is D11 enforced by construction rather than by
 * review.
 */
export function resolveCellSendingIdentity(input: {
	layout: SubdomainLayoutProposal;
	stream: SendingStream;
	arm: TransportArm;
	/** Per-arm selector suffix; defaults keep both arms under one `d=`. */
	armSelectorSuffix?: Record<TransportArm, string>;
}): CellSendingIdentity {
	const host = input.layout.streamHosts[input.stream];
	const role = STREAM_SUBDOMAIN_ROLES[input.stream];
	// Total mapping: every sending role has a plan, and every plan a base — no
	// scan, no optional chain, no fallback base that matches no published record.
	const base = input.layout.subdomainsByRole[role].dkimSelectorBase;
	return {
		stream: input.stream,
		arm: input.arm,
		fromDomain: host,
		dkimDomain: host,
		returnPathDomain: input.layout.bounceHost,
		dkimSelector: armDkimSelector(base, input.arm, input.armSelectorSuffix),
	};
}

// THE D11 GUARD lives in `streamSubdomainRecords.ts`
// (`findPerTransportSubdomainViolations`, `findUnpublishedSigningSelectors`)
// because it must compare what a cell SIGNS with against what the wizard
// PUBLISHES. A guard that only re-derived both arms from this module's own
// layout could never fail — `arm` reaches nothing but the selector here — and a
// guard that cannot fail is not a guard.

// ============ EACH SENDING SUBDOMAIN WARMS ON ITS OWN ============

export interface SubdomainWarmingPlan {
	host: DnsName;
	role: SendingSubdomainRole;
	pool: GovernedIpPool;
	/**
	 * ALWAYS `false`, as a literal type: a subdomain does not inherit the root's
	 * reputation, so it may not inherit the root's warming progress either.
	 */
	readonly inheritsFromRoot: false;
	/** Every new sending name starts at day 1 of the published schedule. */
	startDay: 1;
	streams: SendingStream[];
}

/**
 * One warming state per SENDING subdomain — never one shared with the root and
 * never one shared between `mail.` and `news.`. The bounce host is excluded: it
 * carries the return path and sends nothing, so it has no reputation to warm.
 */
export function planSubdomainWarming(layout: SubdomainLayoutProposal): SubdomainWarmingPlan[] {
	const signing: SigningSubdomainPlan[] = [
		layout.subdomainsByRole.transactional,
		layout.subdomainsByRole.bulk,
	];
	return signing.map((subdomain) => ({
		host: subdomain.host,
		role: subdomain.role,
		pool: subdomain.pool,
		inheritsFromRoot: false,
		startDay: 1,
		streams: subdomain.streams,
	}));
}
