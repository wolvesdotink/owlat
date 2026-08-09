/**
 * THE RELAY SURFACE ALONE — the seams a relay kind answers about a domain whose
 * PRIMARY provider is somebody else, with none of the primary-provider lifecycle.
 *
 * Its own file beside `./relaySurface.ts` (which produces one of these from a
 * core adapter) and `./relayIdentityProof.ts` (which reads the rows they write),
 * rather than inside `./types.ts`: that file declares the PRIMARY provider
 * contract — the kind union, the per-kind identity payloads, the adapter
 * interface a `domains` row's `providerType` resolves to — and the two contracts
 * answer different questions (see below). Keeping them apart is also what holds
 * `./types.ts` under the file-size ratchet (`scripts/check-file-size.sh`).
 */

import type { ReferenceAlignmentArm } from '@owlat/shared/deliverabilityAlignment';
import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import type { RelayDomainIdentityFacts } from './relayIdentityView';

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

/**
 * The three relay seams, keyed by a `string` rather than by a member of
 * `SendingDomainProviderKind` (`./types.ts`).
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
 *    That is `SendingDomainProviderModule` and `isSendingDomainProviderKind`, and
 *    it stays a closed core union: widening it would make
 *    `EMAIL_PROVIDER=plugin.acme.postmark` produce domains whose whole lifecycle
 *    runs through third-party code.
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
	/**
	 * WHAT THIS RELAY SAYS ABOUT ONE SENDING DOMAIN, for the operator surface —
	 * the read seam that makes a registered kind VISIBLE.
	 *
	 * OPTIONAL, and absence is answered rather than hidden: a kind that does not
	 * implement it is described by `describeSharedRelayIdentity`
	 * (`./relayIdentityView.ts`), the generic read of the row every kind after SES
	 * writes. So registering a kind is what puts it on the panel, and implementing
	 * this only ever ADDS what the generic read cannot know — the records to
	 * publish, the kind's own freshness bound, whether ownership is a separate
	 * ceremony. A kind whose rows are NOT in the shared table (SES, whose
	 * identities live in the frozen sibling) must implement it, or it answers for
	 * nothing.
	 *
	 * Returns null for "no identity here yet". The query turns that into
	 * `provisioning` for a relay this deployment has configured, and into no row
	 * at all for one it has not — a distinction only the caller can make, which is
	 * why this reports absence rather than a state.
	 *
	 * Runs inside a QUERY over a page of domains, so implementations do indexed
	 * point reads and pure derivation only.
	 */
	describeRelayIdentity?(
		ctx: QueryCtx | MutationCtx,
		domain: Doc<'domains'>
	): Promise<RelayDomainIdentityFacts | null>;

	/**
	 * OPTIONAL where the three above are required, and for the reason spelled out
	 * on `SendingDomainProviderModule.scheduleRelayIdentityRefresh` (`./types.ts`):
	 * proving a domain and keeping rows in the shared
	 * `sendingDomainRelayIdentities` table are different facts, and SES has the
	 * first without the second.
	 *
	 * This is what makes the due-check sweep the TABLE's dispatch rather than a
	 * chain of kind literals: it asks the registry for the arm and schedules
	 * whatever it gets back, so a bundled plugin transport joins the sweep on the
	 * day it composes and a third kind adds no line to it.
	 */
	scheduleRelayIdentityRefresh?(
		ctx: MutationCtx,
		delayMs: number,
		domainName: string
	): Promise<void>;
}
