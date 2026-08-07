/**
 * The HOSTED sending-domain identity provider — one adapter that serves every
 * bundled plugin transport declaring a `domainIdentity` (the seams plan's P3.2).
 *
 * ONE IMPLEMENTATION, MANY KINDS, and that is the difference from every adapter
 * folder beside this one. `../ses/` and `../mandrill/` each encode a provider's
 * own answers; this encodes the HOST's answers for a tier whose providers are not
 * in this repository. What varies per plugin is the provider conversation, and
 * that lives behind the module the plugin ships — everything the host decides is
 * decided here, identically, for all of them:
 *
 *  - the PROOF. `relayDomainVerified` reads the row and applies one rule (status
 *    verified, both records valid, inside `PLUGIN_RELAY_PROOF_MAX_AGE_MS`). A
 *    plugin cannot widen it, cannot declare its own window, and never sees the
 *    read.
 *  - the ARM. `describeReferenceArm` is built from what a VERIFIED observation
 *    recorded, so an arm is never described for a domain the router would refuse
 *    to relay — the two would otherwise be different sets, and the pre-flight
 *    would report a live misalignment for DNS that is not published.
 *  - the BACKFILL. `ensureRelayIdentity` schedules; it never calls. It runs
 *    inside the mutation that lands a domain's → verified transition, and a
 *    provider outage must not roll that back.
 *
 * The three together are exactly `RelayProvingProviderModule`'s promise, which is
 * what `domainVerification: 'api'` means — and for this tier that word is DERIVED
 * from the presence of the identity module, so a plugin cannot promise one half
 * without the other.
 */

import { internal } from '../../../_generated/api';
import { getSingletonOrganizationId } from '../../../lib/sessionOrganization';
import { isFreshRelayProof, loadRelayIdentityForDomain } from '../relayIdentityProof';
import { loadRelayIdentityRow } from '../relayIdentityPersistence';
import { PLUGIN_RELAY_PROOF_MAX_AGE_MS, readPluginProviderDetails } from './state';
import type { HostedSendTransportDomainIdentityDefinition } from '../../../plugins/sendTransportDomainIdentityCatalog';
import type { ReferenceAlignmentArm } from '@owlat/shared/deliverabilityAlignment';
import type { Doc } from '../../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../../_generated/server';
import type { EnsureRelayIdentityOptions, RelayIdentityProviderModule } from '../types';

/**
 * THE PROOF, asked of the shared rule with this tier's bound.
 *
 * `isFreshRelayProof` is where the five conditions are stated, and it is shared
 * with Mandrill on purpose: both tiers write the same table, and a revision to
 * what counts as proven that landed in only one of them would license a From
 * domain at one relay that the other would refuse, with both suites green. What
 * this tier keeps is {@link PLUGIN_RELAY_PROOF_MAX_AGE_MS}, which a plugin
 * cannot declare, widen, or see.
 */
async function isProvenDomain(
	ctx: QueryCtx | MutationCtx,
	kind: string,
	domainName: string,
	now: number
): Promise<Doc<'sendingDomainRelayIdentities'> | null> {
	const identity = await loadRelayIdentityForDomain(ctx, kind, domainName);
	if (!identity || !isFreshRelayProof(identity, now, PLUGIN_RELAY_PROOF_MAX_AGE_MS)) return null;
	return identity;
}

/**
 * Build the adapter for one registered plugin identity.
 *
 * Takes the DEFINITION rather than the module: none of the three seams talks to
 * the provider. The two that read do indexed point reads, and the one that writes
 * schedules an action — which is what keeps this whole file loadable in the
 * isolate, and therefore on the enqueue path.
 */
export function createHostedRelayIdentityProvider(
	definition: HostedSendTransportDomainIdentityDefinition
): RelayIdentityProviderModule {
	const kind = definition.kind;
	return Object.freeze({
		kind,

		/**
		 * True iff `domainName` carries a fresh, complete proof at this relay: an
		 * identity the provider itself reported verified, with BOTH published records
		 * valid, observed no longer ago than {@link PLUGIN_RELAY_PROOF_MAX_AGE_MS} —
		 * see {@link isProvenDomain}, which is where that rule is asked.
		 */
		async relayDomainVerified(
			ctx: QueryCtx | MutationCtx,
			domainName: string,
			now: number
		): Promise<boolean> {
			return (await isProvenDomain(ctx, kind, domainName, now)) !== null;
		},

		/**
		 * This relay's reference arm for one sending domain, or null when we cannot
		 * honestly describe one.
		 *
		 * VERIFIED-ONLY, and the freshness is the PROOF's rather than the arm's: the
		 * row is re-read through the same rule above rather than restating it, so the
		 * arm the ramp is measured on and the domain the router is allowed to relay
		 * can never be two different sets.
		 *
		 * A verified identity that recorded no DKIM selector still yields null. The
		 * pre-flight resolves these live, so an arm with a guessed (or empty) selector
		 * would be reported to the operator as a real DKIM misalignment on DNS they
		 * published correctly. `null` reaches the pre-flight as `unknown` — a HOLD on
		 * the ramp with the actionable sentence — which is the honest answer.
		 *
		 * `supportsCustomReturnPath` is false for every transport at this tier: the
		 * VERP local part that makes a bounce attributable is signed with a deployment
		 * secret, and a bundled module is handed configuration, never signing keys.
		 */
		async describeReferenceArm(
			ctx: QueryCtx | MutationCtx,
			domain: Doc<'domains'>,
			now: number
		): Promise<ReferenceAlignmentArm | null> {
			const identity = await isProvenDomain(ctx, kind, domain.domain, now);
			if (!identity) return null;
			const dns = readPluginProviderDetails(identity.providerDetails);
			if (dns.dkimSelectors.length === 0) return null;
			return {
				label: definition.label,
				fromDomain: domain.domain,
				// The customer's own domain as `d=` — which is what makes the arm
				// comparable to the own MTA at all (same From domain, same d=, different
				// selector: the alignment contract).
				dkimDomain: domain.domain,
				dkimSelectors: [...dns.dkimSelectors],
				spfMechanisms: [...dns.spfMechanisms],
				supportsCustomReturnPath: false,
			};
		},

		/**
		 * The relay-identity backfill: make sure this relay holds an identity for a
		 * domain whose PRIMARY provider is somebody else (in practice our own MTA).
		 *
		 * SCHEDULES, never calls — this runs inside the drain's transaction and inside
		 * the mutation that lands a `→ verified` transition, and a provider outage
		 * must not roll either back.
		 *
		 * The existence read is SKIPPED for a caller asking `reprovision: true` (the
		 * lifecycle's `→ verified` edge, the operator's only repair lever for an
		 * identity removed at the provider while our row survived). Repeating is safe:
		 * the action re-registers and the mutation upserts.
		 */
		async ensureRelayIdentity(
			ctx: MutationCtx,
			domain: Doc<'domains'>,
			options: EnsureRelayIdentityOptions
		): Promise<void> {
			if (!options.reprovision) {
				const organizationId = await getSingletonOrganizationId(ctx);
				if (await loadRelayIdentityRow(ctx, organizationId, kind, domain.domain.toLowerCase())) {
					return;
				}
			}
			await ctx.scheduler.runAfter(0, internal.domains.pluginRelay.provision, {
				kind,
				domain: domain.domain,
			});
		},

		/**
		 * The due-check sweep's dispatch arm: re-ask this provider about one domain
		 * whose row `by_next_check_due` says is due.
		 *
		 * DECLARED BY THE KINDS THAT KEEP ROWS IN THE SHARED TABLE, which is why it
		 * is optional on the module and absent from SES (whose identities live in
		 * the frozen sibling table and are refreshed by their own path). The sweep
		 * asks the registry for it rather than branching on the kind, so a bundled
		 * plugin transport is on the sweep the day it composes.
		 */
		async scheduleRelayIdentityRefresh(
			ctx: MutationCtx,
			delayMs: number,
			domainName: string
		): Promise<void> {
			await ctx.scheduler.runAfter(delayMs, internal.domains.pluginRelay.refreshIdentity, {
				kind,
				domain: domainName,
			});
		},
	});
}
