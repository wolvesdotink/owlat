/**
 * Sending domain lifecycle — the effect runner (ADR-0018).
 *
 * The reducer in `lifecycleReducer.ts` declares effects; this module runs them.
 * Nothing here writes a `domains` row: effects schedule provider work, clear or
 * provision the per-provider identity sibling rows, and write the audit log.
 * The `domains` writes stay in `lifecycle.ts` (`dispatch` and
 * `patchDomainRecords`), which call in here after their patch lands.
 *
 * Effects:
 *   audit_log                            — every transition + create + remove
 *                                          (skipped on verification self-loops),
 *                                          and every feature-editor write.
 *   register_with_provider               — `create()` and `→ registering`.
 *   clear_provider_identity              — `→ registering` when a previous
 *                                          identity sibling row exists.
 *   delete_with_provider                 — `remove()`.
 *   claim_reserved_mailboxes             — `→ verified`; provisions mailboxes
 *                                          reserved on the domain for invitees
 *                                          who already accepted.
 *   provision_relay_identity_if_enabled  — `→ verified`; provisions the
 *                                          coexisting relay identity the
 *                                          fallback configuration calls for.
 */

import type { MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { recordAuditLog } from '../lib/auditLog';
import {
	enabledFallbackRelayKinds,
	ensureRelayIdentities,
	relayIdentityBackfills,
} from '../lib/sendProviders/fallbackRelays';
import { providerFor } from './providers';
import type { Effect } from './lifecycleReducer';

export async function applyEffects(
	ctx: MutationCtx,
	effects: ReadonlyArray<Effect>,
	userId: string
): Promise<void> {
	for (const effect of effects) {
		switch (effect.kind) {
			case 'audit_log': {
				await recordAuditLog(ctx, {
					userId,
					action: effect.action,
					resource: 'sending_domain',
					resourceId: effect.domainId,
					details: effect.details,
				});
				break;
			}
			case 'register_with_provider': {
				await ctx.scheduler.runAfter(0, internal.domains.providers.registerAction.run, {
					providerType: effect.providerType,
					domainId: effect.domainId,
				});
				break;
			}
			case 'clear_provider_identity': {
				const adapter = providerFor(effect.providerType);
				await adapter.clearIdentity(ctx, effect.domainId);
				break;
			}
			case 'delete_with_provider': {
				await ctx.scheduler.runAfter(
					0,
					internal.domains.providers.registerAction.deleteDomainAction,
					{ providerType: effect.providerType, domain: effect.domain }
				);
				break;
			}
			case 'claim_reserved_mailboxes': {
				// Scheduled, not inline: a throw while provisioning a reserved mailbox
				// must never roll back the domain's → verified transition itself (same
				// reasoning as register_with_provider / delete_with_provider above).
				await ctx.scheduler.runAfter(
					0,
					internal.mail.pendingMailbox.provisionReservationsForVerifiedDomain,
					{ domain: effect.domain }
				);
				break;
			}
			case 'provision_relay_identity_if_enabled': {
				// THE FORWARD HALF OF A PAIR, and the pair shares ONE implementation:
				// `enabledFallbackRelayKinds` → `relayIdentityBackfills` →
				// `ensureRelayIdentities` is the whole rule, and the catch-up drain
				// (`providerRoutes.provisionDeliverabilityRelayBatch`) walks the same
				// three. Neither the "which relay" reading, nor the registry filter,
				// nor the own-MTA-primary gate is restated here — two spellings of
				// "every domain gets an identity exactly once" is how one half starts
				// provisioning a domain the other half skips, with the only symptom a
				// relay refusing a real send.
				const backfills = relayIdentityBackfills(await enabledFallbackRelayKinds(ctx));
				if (backfills.length === 0) break;
				// The doc is re-read rather than taken from the effect: the status
				// patch has already landed, and the own-MTA gate downstream reads the
				// same subject the drain reads.
				const domain = await ctx.db.get(effect.domainId);
				if (!domain) break;
				// `reprovision: true` — this edge shipped UNCONDITIONAL and stays so.
				// It fires only on a real `→ verified` transition, which an operator
				// reaches by taking the domain out of `verified` and putting it back,
				// and that deliberate act is their only lever for re-registering an
				// identity deleted or disabled at the provider while our sibling row
				// survived. The drain converges instead (`reprovision: false`); see
				// `EnsureRelayIdentityOptions`.
				//
				// Adapters SCHEDULE the provider call rather than making it, and
				// `ensureRelayIdentities` swallows a throw from any read they make
				// first: nothing in this effect may roll back the domain's → verified
				// transition (the same reasoning as `register_with_provider`).
				await ensureRelayIdentities(ctx, domain, backfills, { reprovision: true });
				break;
			}
		}
	}
}
