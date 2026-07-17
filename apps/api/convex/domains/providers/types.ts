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

import type { Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { DnsRecords } from '../domains';

export type SendingDomainProviderKind = 'mta' | 'ses';

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

export type ProviderIdentity = MtaIdentity | SesIdentity;

export type ProviderIdentityFor<K extends SendingDomainProviderKind> = K extends 'mta'
	? MtaIdentity
	: K extends 'ses'
		? SesIdentity
		: never;

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
