/**
 * The plugin relay identity row — this tier's three writes, each one a call to
 * the shared write rules with the two things a tier owns filled in.
 *
 * THE RULES THEMSELVES LIVE IN `../relayIdentityPersistence.ts` (what a failed
 * call may overwrite, what an outage may not, why `lastCheckedAt` dates the
 * evidence rather than the write), because Mandrill obeys exactly the same ones
 * against exactly the same table and a second copy of them is a second copy that
 * can drift. What is stated HERE is only what is true of this tier: its cadence
 * table and its `providerDetails` blob.
 *
 * One difference from every core adapter, and it is the whole tier's difference:
 * every function takes the PROVIDER KIND, because there is one implementation
 * for every bundled plugin identity rather than one per provider.
 *
 * Rows live in the generic `sendingDomainRelayIdentities` table under
 * `providerKind: 'plugin.<id>.<local>'` — a plain string field, additive, no
 * schema change (D10: rows, not columns).
 */

import {
	loadRelayIdentityRow,
	markRelayIdentityFailed,
	scheduleRelayIdentityRetry,
	upsertRelayIdentityRow,
} from '../relayIdentityPersistence';
import {
	buildFailedPluginProviderDetails,
	buildPluginProviderDetails,
	nextPluginCheckDueAt,
	type PluginRelayObservation,
} from './state';
import type { Doc } from '../../../_generated/dataModel';
import type { MutationCtx } from '../../../_generated/server';

/**
 * The row for one (organization, domain, plugin kind).
 *
 * Keyed by domain NAME rather than by `domainId`, because that is how the
 * generic table is keyed: a relay identity can exist for a domain whose primary
 * `domains` row belongs to another provider entirely, and the enqueue-path proof
 * looks it up by envelope From domain with no id in hand.
 */
export async function loadPluginRelayRow(
	ctx: MutationCtx,
	organizationId: string,
	kind: string,
	domain: string
): Promise<Doc<'sendingDomainRelayIdentities'> | null> {
	return await loadRelayIdentityRow(ctx, organizationId, kind, domain);
}

/** Upsert one OBSERVED identity, under this tier's cadence and blob. */
export async function upsertPluginRelayIdentity(
	ctx: MutationCtx,
	kind: string,
	domainName: string,
	observation: PluginRelayObservation,
	checkedAt: number
): Promise<void> {
	await upsertRelayIdentityRow(ctx, {
		kind,
		domain: domainName,
		status: observation.status,
		spf: observation.spf,
		dkim: observation.dkim,
		providerDetails: JSON.stringify(buildPluginProviderDetails(observation)),
		checkedAt,
		nextCheckDueAt: nextPluginCheckDueAt(observation.status, checkedAt),
	});
}

/**
 * A credential the provider rejected (or one this deployment does not have).
 *
 * The reason is merged into a TYPED blob rather than an object literal, so
 * `lastError` has one declaration and one writer — renaming the field on
 * `PluginRelayProviderDetails` then breaks the write instead of silently leaving
 * it emitting the old key.
 */
export async function markPluginRelayIdentityFailed(
	ctx: MutationCtx,
	kind: string,
	domainName: string,
	error: string,
	now: number
): Promise<void> {
	await markRelayIdentityFailed(ctx, {
		kind,
		domain: domainName,
		now,
		nextCheckDueAt: nextPluginCheckDueAt('failed', now),
		buildProviderDetails: (stored) =>
			JSON.stringify(buildFailedPluginProviderDetails(stored, error)),
	});
}

/**
 * The call produced no answer — an outage, a module that threw, a shape we could
 * not read, or a contribution that is no longer authorized to be called at all.
 *
 * `retryDelayMs` is the CALLER's because the non-answers differ in how long they
 * are worth waiting out: an outage is transient (`PLUGIN_UNAVAILABLE_RETRY_MS`),
 * a revoked grant is a state an operator chose and will not leave on its own
 * (`PLUGIN_DENIED_RETRY_MS`). Neither writes anything but the retry.
 */
export async function schedulePluginRelayRetry(
	ctx: MutationCtx,
	kind: string,
	domainName: string,
	now: number,
	retryDelayMs: number
): Promise<void> {
	await scheduleRelayIdentityRetry(ctx, {
		kind,
		domain: domainName,
		now,
		nextCheckDueAt: now + retryDelayMs,
	});
}
