/**
 * Sending domain provider adapter (module) — shared types.
 *
 * One TypeScript interface, two concrete implementations (MTA and SES). The
 * **Sending domain lifecycle (module)** dispatches per-provider work through
 * `providerFor(kind)` in `./index.ts`; provider variation lives entirely
 * behind this seam.
 *
 * Per ADR-0018:
 * - Each adapter owns its per-provider sibling identity table
 *   (`sendingDomainMtaIdentities` for MTA, `sendingDomainSesIdentities`
 *   for SES).
 * - The provider's `registerDomain` returns both the DNS records to publish
 *   and the typed identity row to insert. The lifecycle persists both
 *   atomically on `registering → pending`.
 * - The optional `runProviderCheck` is the provider's contribution to "what
 *   counts as verified" — combined with the generic DNS rule in the
 *   lifecycle reducer.
 */

import type { ReferenceAlignmentArm } from '@owlat/shared/deliverabilityAlignment';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import type { DnsRecords } from '../domains';

// ─── Per-provider identity shapes ──────────────────────────────────────────

export type MtaIdentity = {
	kind: 'mta';
	dkimSelector: string;
};

export type SesIdentity = {
	kind: 'ses';
	dkimTokens: string[];
	verificationToken: string;
};

/**
 * A Mandrill sending-domain identity, as `senders/add-domain` /
 * `senders/check-domain` last described it (P3.1).
 *
 * It carries STATE rather than secrets or per-domain tokens, which is the whole
 * difference from SES: Mandrill signs every account's mail with one shared,
 * account-independent `mandrill` selector, so there is no per-domain key
 * material to remember — the DNS records are a pure function of the domain name
 * (`./mandrill/records.ts`). What only Mandrill can tell us is whether it can
 * SEE those records and whether the domain's ownership has been verified, and
 * that is exactly what this payload is.
 */
export type MandrillIdentity = {
	kind: 'mandrill';
	/** The (shared) selector Mandrill signs with — `mandrill`. */
	dkimSelector: string;
	/** Provider-side lifecycle, derived from the fields below. */
	status: RelayIdentityStatus;
	/** Mandrill's own verdict on the published SPF record. */
	spf: { isValid: boolean; error?: string };
	/** Mandrill's own verdict on the published DKIM record. */
	dkim: { isValid: boolean; error?: string };
	/** Mandrill's aggregate "this domain may be used to sign mail". */
	isValidSigning: boolean;
	/** Mandrill's ownership-verification timestamp, absent until it clears. */
	verifiedAt?: number;
	/**
	 * The TXT token that verifies domain OWNERSHIP without the verification
	 * mail, when this account's API returns one. Absent means the operator has
	 * to complete Mandrill's mailbox verification instead — surfaced as an
	 * instruction, never guessed at.
	 */
	verifyTxtKey?: string;
	/** When the provider state above was read. */
	checkedAt: number;
};

/**
 * The `sendingDomainRelayIdentities.status` lifecycle, spelled once here so the
 * identity payloads and the row stay one declaration.
 */
export type RelayIdentityStatus = 'unverified' | 'pending_dns' | 'verified' | 'failed';

/**
 * The REGISTRY of sending-domain provider kinds, keyed by kind (D7). One line
 * per provider, mirroring `SEND_PROVIDERS` in `lib/sendProviders/index.ts`:
 * the kind union, the per-kind identity payload and the module registry's
 * completeness guard all derive from this single map, so adding a provider is
 * one entry here plus one entry in `SENDING_DOMAIN_PROVIDERS`.
 *
 * It replaced a hand-written `'mta' | 'ses'` union beside a
 * `K extends 'mta' ? … : K extends 'ses' ? … : never` conditional ladder —
 * two declarations of the same fact, which the third provider would have had
 * to extend in both places (and `never` on a miss, so forgetting one produced
 * an uninhabited identity type rather than an error).
 */
export interface SendingDomainIdentityRegistry {
	mta: MtaIdentity;
	ses: SesIdentity;
	mandrill: MandrillIdentity;
}

export type SendingDomainProviderKind = keyof SendingDomainIdentityRegistry;

export type ProviderIdentityFor<K extends SendingDomainProviderKind> =
	SendingDomainIdentityRegistry[K];

export type ProviderIdentity = SendingDomainIdentityRegistry[SendingDomainProviderKind];

// ─── Per-provider check result ─────────────────────────────────────────────

export type ProviderCheckResult = {
	verified: boolean;
	lastError?: string;
};

// ─── Adapter interface ─────────────────────────────────────────────────────

export interface SendingDomainProviderModule<K extends SendingDomainProviderKind> {
	readonly kind: K;

	// ── Provider API calls (run inside 'use node' actions) ────────────────

	/**
	 * Register the domain at the provider's identity API. Returns the DNS
	 * records to publish and the typed identity row to insert. Throws on
	 * provider failure — the `register_with_provider` effect handler catches
	 * and translates to a `→ failed` lifecycle transition.
	 *
	 * `options.returnPathHost` is the domain's per-domain VERP return-path host
	 * (D1/D2). When set, the MTA adapter reflects it to the MTA and builds the
	 * `mailFrom` SPF record on that host; when absent it falls back to the
	 * deployment-global `MTA_RETURN_PATH_DOMAIN` env (historic behavior). SES has
	 * no return-path concept and ignores it.
	 */
	registerDomain(
		domain: string,
		options?: { returnPathHost?: string }
	): Promise<{
		dnsRecords: DnsRecords;
		identity: ProviderIdentityFor<K>;
	}>;

	/**
	 * Best-effort cleanup at the provider's API. Called from the
	 * `clear_provider_identity` and `delete_with_provider` effects.
	 */
	deleteFromProvider(domain: string): Promise<void>;

	/**
	 * Human-readable, provider-specific fragment describing a freshly
	 * registered identity (e.g. MTA's DKIM selector, SES's token count).
	 * Used only for the generic register action's success log line.
	 */
	describeIdentity(identity: ProviderIdentityFor<K>): string;

	/**
	 * Optional per-provider verification check. Today only SES has one
	 * (live `getVerificationStatus` call); MTA omits it (the lifecycle
	 * treats absent as `{ verified: true }`). Called by the DNS verifier
	 * action before `recordVerification`.
	 */
	runProviderCheck?(domain: string): Promise<ProviderCheckResult>;

	// ── Relay-domain verification (runs inside queries/mutations) ─────────

	/**
	 * Does this provider hold a fresh, complete proof that `domainName` may be
	 * RELAYED through it right now? The read half of the deliverability
	 * fallback (D6), called by `lib/sendProviders/relayDomainVerification.ts`
	 * once the configured relay kind has been resolved to its provider.
	 *
	 * OPTIONAL, and absence is a real answer rather than a gap: a kind with no
	 * implementation keeps the seam's honest "unverifiable" posture, which is
	 * exactly what a relay with no identity API (`domainVerification: 'none'`)
	 * can truthfully say. Every kind declaring `domainVerification: 'api'`
	 * should implement it — the catalog is what promises the proof exists.
	 *
	 * Runs on the ENQUEUE path, so implementations do indexed point reads only:
	 * no `.collect()`, no `ctx.db.get`, no `ctx.runQuery` (see the read-set
	 * guard in `delivery/__tests__/sendAssignments.test.ts`).
	 */
	relayDomainVerified?(
		ctx: QueryCtx | MutationCtx,
		domainName: string,
		now: number
	): Promise<boolean>;

	/**
	 * This provider's REFERENCE ARM for one sending domain — the second arm the
	 * dual-transport alignment pre-flight compares the own MTA against
	 * (`delivery/alignmentPreflight.ts`).
	 *
	 * Null means "configured, but we cannot describe this domain's signing
	 * identity at this relay", which the pre-flight turns into `unknown` — a
	 * HOLD on the ramp, never an opened gate. That is the honest answer for a
	 * relay whose identity has not been registered (or, for a provider that can
	 * tell, not yet verified), and it is why this returns null rather than a
	 * half-filled arm: an arm with a guessed selector would be checked against
	 * live DNS and reported as a real misalignment on the operator's screen.
	 *
	 * OPTIONAL because most kinds are never a reference arm — our own MTA is the
	 * first arm by construction. A kind with no implementation keeps today's
	 * conservative `unknown`.
	 *
	 * Runs inside a QUERY (the sweep and the wizard read), not on the enqueue
	 * path, so an indexed read plus a `ctx.db.get` is fine here.
	 */
	describeReferenceArm?(
		ctx: QueryCtx | MutationCtx,
		domain: Doc<'domains'>,
		now: number
	): Promise<ReferenceAlignmentArm | null>;

	/**
	 * BACKFILL: make sure this provider holds a relay identity for `domain`,
	 * whose PRIMARY provider is somebody else (in practice our own MTA).
	 *
	 * The write half of what {@link relayDomainVerified} later reads, and the
	 * catch-up path for the domains that already existed when an operator
	 * switched the deliverability fallback on —
	 * `providerRoutes.provisionDeliverabilityRelayBatch` walks them and asks
	 * this of the kind the route named.
	 *
	 * Domains verified AFTER that point are meant to get theirs from the
	 * lifecycle's `provision_relay_identity_if_enabled` effect, so that the two
	 * paths together cover every domain exactly once. Today that effect
	 * (`domains/lifecycle.ts`) still schedules per relay kind from a hand-written
	 * if-chain rather than through this method: the pairing holds for the two
	 * shipped kinds, but a NEW `domainVerification: 'api'` kind gets the backfill
	 * and not the forward path until P0.4 routes that site here — which is why
	 * the comment there names this method rather than leaving the next author to
	 * invent a second seam.
	 *
	 * Implementations SCHEDULE the provider call rather than making it: this
	 * runs inside the drain's transaction, and a provider outage must not roll
	 * back a batch (the same reasoning as `register_with_provider`). They also
	 * own the "already have one?" check, because where that identity lives is
	 * per-provider knowledge — the frozen `sendingDomainSesIdentities` sibling
	 * for SES, the generic `sendingDomainRelayIdentities` row for every kind
	 * after it (D7).
	 *
	 * Takes the whole `domains` DOC, not an id: the caller is a paginated drain
	 * that already holds the row (it filters on `providerType` a line earlier),
	 * and a name-keyed implementation re-reading it would cost one extra
	 * document read per domain per page — plus a "the row vanished mid-drain"
	 * branch that cannot happen when the doc was in hand.
	 *
	 * OPTIONAL, and absence is a real answer rather than a gap: a kind with no
	 * identity API to register at (`domainVerification: 'none'` — our own MTA,
	 * Resend, a bring-your-own SMTP relay) has no relay identity to backfill,
	 * and the drain then does nothing at all rather than provisioning some other
	 * kind's. Every kind declaring `domainVerification: 'api'` implements it —
	 * pinned by `./__tests__/registry.test.ts`, beside the same completeness rule
	 * for {@link relayDomainVerified}, because a kind that promises a proof and
	 * never provisions the identity that proof is read from reports every domain
	 * unverified and its fallback never relays.
	 */
	ensureRelayIdentity?(ctx: MutationCtx, domain: Doc<'domains'>): Promise<void>;

	// ── Sibling-row persistence (run inside mutations) ────────────────────

	/**
	 * Upsert the per-provider sibling identity row. Called from the
	 * lifecycle reducer on `registering → pending`. Application-enforces
	 * the 1:0..1 invariant — patches existing row rather than inserting a
	 * duplicate.
	 */
	writeIdentity(
		ctx: MutationCtx,
		domainId: Id<'domains'>,
		identity: ProviderIdentityFor<K>
	): Promise<void>;

	/**
	 * Delete the per-provider sibling identity row. Called from the
	 * lifecycle reducer on `→ registering` (regenerate) and `remove()`.
	 * No-op when no row exists.
	 */
	clearIdentity(ctx: MutationCtx, domainId: Id<'domains'>): Promise<void>;
}
