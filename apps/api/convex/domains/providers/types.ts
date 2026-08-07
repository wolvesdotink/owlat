/**
 * Sending domain provider adapter (module) — shared types.
 *
 * One TypeScript interface, one concrete implementation per registered kind
 * (`SendingDomainIdentityRegistry` below). The **Sending domain lifecycle
 * (module)** dispatches per-provider work through `providerFor(kind)` in
 * `./index.ts`; provider variation lives entirely behind this seam — with the
 * RETURN-PATH branches the lifecycle still carries of its own as the stated
 * exception (`./index.ts`'s header says what they cost a new kind). The seams
 * plan's P0.4 cleared the identity ones: both relay-identity provisioning paths
 * now walk the registry through
 * {@link SendingDomainProviderModule.ensureRelayIdentity}.
 *
 * PLAN NUMBERS: every D-/P-number in this file names its plan, because more
 * than one plan's numbering reaches this seam — the Mandrill provider plan's
 * for the registry and the relay seams, the seams plan's for P0.3/P0.4, and
 * the per-domain return-path work (#408) for `returnPathHost`.
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
 * `senders/check-domain` last described it (Mandrill P3.1).
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
 * The REGISTRY of sending-domain provider kinds, keyed by kind (Mandrill D7). One line
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

/**
 * The slice of `domains.verificationResults` a provider may write about ITSELF
 * — its own verdict, mirrored into the record bundle that travels with the
 * domain's DNS results.
 *
 * PERSISTED, AND CURRENTLY UNREAD BY THE WEB APP. `sesStatus` is written here
 * and by `domains/sesRelayVerification.ts`, validated in
 * `lib/convexValidators.ts`, and read by nothing in `apps/web` — the
 * domain-records screen renders spf/dkim/dmarc/mailFrom only. The seam is
 * therefore about WHO DECIDES the projection, not about a pill on a screen: a
 * developer adding provider #4 should implement it to keep the provider's own
 * verdict in the domain's record, and should not expect it to appear anywhere
 * until the domain-records UI grows a consumer (P1.2 territory).
 *
 * The key is SES-named because the PERSISTED FIELD is (rows written since long
 * before this seam existed). That is schema vocabulary, not an identity check:
 * per D10 persisted shapes stay additive, so a second provider that wants a
 * status of its own adds its OWN optional key here and fills it from its OWN
 * adapter. What the seam removes is the `providerType === 'ses'` branch that
 * used to decide, in `domains/dnsVerification.ts`, which provider was allowed
 * to have a verdict worth recording.
 */
export type ProviderVerificationStatusFields = {
	/** SES's `verificationStatus`, spelled as the persisted field has always held it. */
	readonly sesStatus?: string;
};

/**
 * WHY the caller is asking for a relay identity — the one thing the two
 * provisioning halves do NOT agree on.
 *
 * They agree on everything else (which relays, which domains, schedule-never-
 * call), which is why they share one implementation since P0.4. They do not
 * agree on what "ensure" means when a sibling row already exists:
 *
 *  - the CATCH-UP DRAIN (`providerRoutes.provisionDeliverabilityRelayBatch`)
 *    walks every verified domain on every page and must be cheap and
 *    convergent: a domain that already has a row is done, and re-registering it
 *    would re-issue a provider call per domain per drain. `reprovision: false`.
 *  - the FORWARD PATH (`domains/lifecycle.ts`'s
 *    `provision_relay_identity_if_enabled`) fires on a real `→ verified` edge,
 *    which an operator can only reach by taking the domain out of `verified`
 *    and putting it back. That deliberate act is the ONLY repair lever for an
 *    identity deleted or disabled at the provider while our sibling row
 *    survived — nothing in the stored state distinguishes that from "waiting
 *    for the CNAMEs", so the drain cannot detect it and no other surface
 *    re-registers. It shipped unconditional and it stays unconditional:
 *    `reprovision: true`.
 *
 * Required rather than optional, and a named field rather than a bare boolean,
 * because the failure it prevents is silent in both directions — a drain that
 * re-provisions hammers the provider, a forward path that does not quietly
 * removes the repair lever, and neither shows up in a test that only checks
 * that a row exists afterwards.
 */
export type EnsureRelayIdentityOptions = {
	readonly reprovision: boolean;
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
	 * (the return-path work's D1/D2 — #408). When set, the MTA adapter reflects
	 * it to the MTA and builds the
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
	 * Optional per-provider verification check, called by the DNS verifier
	 * action before `recordVerification`.
	 *
	 * A capability, not a kind: whichever kinds hold a provider-side opinion
	 * about whether the domain is verified implement it (today SES's live
	 * `getVerificationStatus` and Mandrill's `check-domain`). A kind with no
	 * such API omits it — our own MTA does — and the lifecycle treats absent as
	 * `{ verified: true }`, i.e. the DNS evidence stands alone.
	 */
	runProviderCheck?(domain: string): Promise<ProviderCheckResult>;

	/**
	 * Optional: this provider's own verdict, projected into the shared
	 * `domains.verificationResults` bundle that is persisted beside the DNS
	 * results (see {@link ProviderVerificationStatusFields}, which says plainly
	 * what does and does not read the projection today).
	 *
	 * Pure and synchronous: the verdict is already in hand — the verifier has just
	 * awaited {@link runProviderCheck} — and this only decides how to SPELL it.
	 *
	 * OPTIONAL, and absence is a real answer: a kind with no provider verdict to
	 * record (our own MTA has none at all; Mandrill keeps its state on its own
	 * identity row) omits it and the verifier writes nothing extra,
	 * which is exactly what the `providerType === 'ses'` branch this replaced
	 * achieved for every kind that was not SES.
	 */
	verificationStatusFields?(check: ProviderCheckResult): ProviderVerificationStatusFields;

	// ── Relay-domain verification (runs inside queries/mutations) ─────────

	/**
	 * Does this provider hold a fresh, complete proof that `domainName` may be
	 * RELAYED through it right now? The read half of the deliverability
	 * fallback (Mandrill D6), called by `lib/sendProviders/relayDomainVerification.ts`
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
	 * BOTH HALVES ASK THIS METHOD (the seams plan's P0.4). Domains verified after
	 * the operator switched the fallback on get theirs from the lifecycle's
	 * `provision_relay_identity_if_enabled` effect, which walks the same registry
	 * with the same relay kinds — so the two paths together cover every domain
	 * exactly once, and a NEW `domainVerification: 'api'` kind is on both the
	 * moment it registers. The forward path used to be a hand-written if-chain
	 * naming `ses` and `mandrill`, which gave a newly registered kind the backfill
	 * and NOT the forward path: its domains verified, silently received no relay
	 * identity, and its fallback then refused to relay them, with the only symptom
	 * a runtime refusal on a real send.
	 *
	 * Implementations SCHEDULE the provider call rather than making it: this
	 * runs inside the drain's transaction, and a provider outage must not roll
	 * back a batch (the same reasoning as `register_with_provider`). They also
	 * own the "already have one?" check, because where that identity lives is
	 * per-provider knowledge — the frozen `sendingDomainSesIdentities` sibling
	 * for SES, the generic `sendingDomainRelayIdentities` row for every kind
	 * after it (Mandrill D7).
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
	 *
	 * The CALLER'S INTENT travels with the call — see
	 * {@link EnsureRelayIdentityOptions}. The two halves genuinely want different
	 * things from "ensure", and the parameter is what keeps sharing one
	 * implementation from silently picking one of them.
	 */
	ensureRelayIdentity?(
		ctx: MutationCtx,
		domain: Doc<'domains'>,
		options: EnsureRelayIdentityOptions
	): Promise<void>;

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

/**
 * The module shape a kind declaring `domainVerification: 'api'` must have —
 * every optional relay seam above, made REQUIRED.
 *
 * The catalog entry is a PROMISE ("this relay can prove a sending domain"), and
 * three separate pieces of the system read it: the enqueue-path proof
 * (`relayDomainVerified`), the backfill that writes the identity that proof is
 * read from (`ensureRelayIdentity`), and the alignment pre-flight's second arm
 * (`describeReferenceArm`). A provider that is REGISTERED but implements none of
 * them satisfies the registry's completeness guard and still breaks all three:
 * every domain reports unverified, the fallback refuses to relay any of them,
 * and the ramp holds at s=0 — with the only symptom a runtime refusal on a real
 * send, in a deployment that had just been told its relay was ready.
 *
 * The methods stay OPTIONAL on {@link SendingDomainProviderModule} because
 * absence is a real answer for a kind that declares `domainVerification: 'none'`
 * (our own MTA, Resend, a bring-your-own SMTP relay): it keeps the seam's honest
 * "unverifiable" posture rather than being a gap. This type is how the two
 * readings are kept apart — the same field being absent is legitimate for one
 * kind and a build failure for another, and which one it is comes from the
 * catalog rather than from a reviewer noticing.
 *
 * Annotate an `api` kind's adapter with this (see `../ses/index.ts`,
 * `../mandrill/index.ts`). The registry's `_relayProofTypecheck` in `./index.ts`
 * is what makes forgetting to a compile error rather than a convention.
 */
export type RelayProvingProviderModule<K extends SendingDomainProviderKind> =
	SendingDomainProviderModule<K> &
		Required<
			Pick<
				SendingDomainProviderModule<K>,
				'relayDomainVerified' | 'ensureRelayIdentity' | 'describeReferenceArm'
			>
		>;

/**
 * THE RELAY SURFACE ALONE — the three seams above, with none of the
 * primary-provider lifecycle, and keyed by a `string` rather than by a member of
 * {@link SendingDomainProviderKind}.
 *
 * WHY IT EXISTS (the seams plan's P3.2). A bundled plugin transport can now
 * contribute a sending-domain identity, and its kind is `plugin.<id>.<local>` —
 * a value no static union can hold, since the set is decided by
 * `plugins.config.ts` at composition time. But that is only half the reason; the
 * other half is that a plugin relay answers a genuinely SMALLER question than a
 * core adapter does.
 *
 * TWO QUESTIONS, NOT ONE, and conflating them is what this type prevents:
 *
 *  - "is this a PRIMARY sending-domain provider kind?" — the one a `domains` row
 *    records in `providerType`, whose adapter registers the domain, writes the
 *    sibling identity, publishes the DNS bundle and handles the return path.
 *    That is {@link SendingDomainProviderModule} and
 *    `isSendingDomainProviderKind`, and it stays a closed core union: widening it
 *    would make `EMAIL_PROVIDER=plugin.acme.postmark` produce domains whose whole
 *    lifecycle runs through third-party code.
 *  - "can this RELAY kind prove a domain?" — asked by the routing gate, the
 *    identity backfill and the alignment pre-flight, about a relay that COEXISTS
 *    on a domain our own MTA hosts. That is this type, and it is open.
 *
 * Every core adapter that implements all three (`RelayProvingProviderModule`) is
 * structurally one of these already, which is why the composed registry in
 * `./index.ts` holds core and plugin entries side by side with no adaptation.
 */
export interface RelayIdentityProviderModule {
	readonly kind: string;
	relayDomainVerified(
		ctx: QueryCtx | MutationCtx,
		domainName: string,
		now: number
	): Promise<boolean>;
	describeReferenceArm(
		ctx: QueryCtx | MutationCtx,
		domain: Doc<'domains'>,
		now: number
	): Promise<ReferenceAlignmentArm | null>;
	ensureRelayIdentity(
		ctx: MutationCtx,
		domain: Doc<'domains'>,
		options: EnsureRelayIdentityOptions
	): Promise<void>;
}
