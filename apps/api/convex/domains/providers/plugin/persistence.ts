/**
 * The plugin relay identity row — every write of it, in one place.
 *
 * The same file, for the same reason, as `../mandrill/persistence.ts`: the WRITE
 * RULES (what a failed call may overwrite, and what it may not) are pinned in one
 * readable place rather than spread across an adapter method and a mutation
 * handler. One difference from Mandrill's, and it is the whole tier's difference:
 * every function here takes the PROVIDER KIND, because there is one
 * implementation for every bundled plugin identity rather than one per provider.
 *
 * Rows live in the generic `sendingDomainRelayIdentities` table under
 * `providerKind: 'plugin.<id>.<local>'` — a plain string field, additive, no
 * schema change (D10: rows, not columns).
 */

import { CURRENT_RELAY_IDENTITY_PROVIDER_DETAILS_VERSION } from '../../../lib/constants';
import { getSingletonOrganizationId } from '../../../lib/sessionOrganization';
import {
	buildPluginProviderDetails,
	nextPluginCheckDueAt,
	PLUGIN_UNAVAILABLE_RETRY_MS,
	type PluginRelayObservation,
} from './state';
import type { Doc } from '../../../_generated/dataModel';
import type { MutationCtx } from '../../../_generated/server';

/**
 * The row for one (organization, domain, plugin kind).
 *
 * Keyed by domain NAME rather than by `domainId`, because that is how the generic
 * table is keyed: a relay identity can exist for a domain whose primary `domains`
 * row belongs to another provider entirely, and the enqueue-path proof looks it
 * up by envelope From domain with no id in hand.
 */
export async function loadPluginRelayRow(
	ctx: MutationCtx,
	organizationId: string,
	kind: string,
	domain: string
): Promise<Doc<'sendingDomainRelayIdentities'> | null> {
	return await ctx.db
		.query('sendingDomainRelayIdentities')
		.withIndex('by_org_domain_provider', (q) =>
			q.eq('organizationId', organizationId).eq('domain', domain).eq('providerKind', kind)
		)
		.first();
}

/**
 * Upsert one OBSERVED identity. Application-enforces the one-row-per
 * (org, domain, kind) invariant, exactly as every other writer of this table does
 * for its own key.
 *
 * `lastCheckedAt` comes from the time the OBSERVATION was made, not from the
 * write: it dates the EVIDENCE, and the relay proof's freshness bound reads it.
 * Stamping the write time would let a row written long after the call it
 * describes look fresher than the fact it holds.
 */
export async function upsertPluginRelayIdentity(
	ctx: MutationCtx,
	kind: string,
	domainName: string,
	observation: PluginRelayObservation,
	checkedAt: number
): Promise<void> {
	const organizationId = await getSingletonOrganizationId(ctx);
	const domain = domainName.toLowerCase();
	const existing = await loadPluginRelayRow(ctx, organizationId, kind, domain);
	const now = Date.now();
	const fields = {
		status: observation.status,
		spf: observation.spf,
		dkim: observation.dkim,
		providerDetails: JSON.stringify(buildPluginProviderDetails(observation)),
		providerDetailsVersion: CURRENT_RELAY_IDENTITY_PROVIDER_DETAILS_VERSION,
		lastCheckedAt: checkedAt,
		nextCheckDueAt: nextPluginCheckDueAt(observation.status, checkedAt),
		updatedAt: now,
	};
	if (existing) {
		await ctx.db.patch(existing._id, fields);
		return;
	}
	await ctx.db.insert('sendingDomainRelayIdentities', {
		organizationId,
		domain,
		providerKind: kind,
		...fields,
		createdAt: now,
	});
}

/**
 * A credential the provider rejected (or one this deployment does not have).
 *
 * `failed` is written, and the SPF/DKIM verdicts are left EXACTLY as they were: a
 * bad API key is not evidence that the operator's DNS stopped being valid, and
 * overwriting the verdicts would make the domain screen tell them to republish
 * records that are fine. `lastCheckedAt` is not advanced either — nothing was
 * checked — so the relay proof ages out on schedule instead of being kept alive
 * by failures.
 *
 * No row of its own is created when none exists: a deployment with no identity at
 * this relay and a bad key has nothing to say about a domain, and inventing a
 * `failed` row would put a red state on a domain nobody ever connected.
 */
export async function markPluginRelayIdentityFailed(
	ctx: MutationCtx,
	kind: string,
	domainName: string,
	error: string,
	now: number
): Promise<void> {
	const organizationId = await getSingletonOrganizationId(ctx);
	const existing = await loadPluginRelayRow(ctx, organizationId, kind, domainName.toLowerCase());
	if (!existing) return;
	await ctx.db.patch(existing._id, {
		status: 'failed',
		providerDetails: JSON.stringify({
			...(existing.providerDetails ? safeParse(existing.providerDetails) : {}),
			kind: 'plugin',
			lastError: error,
		}),
		providerDetailsVersion: CURRENT_RELAY_IDENTITY_PROVIDER_DETAILS_VERSION,
		nextCheckDueAt: nextPluginCheckDueAt('failed', now),
		updatedAt: now,
	});
}

/**
 * The provider did not answer (or the module threw). The identity is left
 * UNTOUCHED except for when to ask again — an outage is evidence of nothing, and
 * in particular it must not refresh `lastCheckedAt`, or a long enough outage
 * would keep a stale proof alive forever by never being able to confirm it.
 */
export async function schedulePluginRelayRetry(
	ctx: MutationCtx,
	kind: string,
	domainName: string,
	now: number
): Promise<void> {
	const organizationId = await getSingletonOrganizationId(ctx);
	const existing = await loadPluginRelayRow(ctx, organizationId, kind, domainName.toLowerCase());
	if (!existing) return;
	await ctx.db.patch(existing._id, {
		nextCheckDueAt: now + PLUGIN_UNAVAILABLE_RETRY_MS,
		updatedAt: now,
	});
}

/** Best-effort read of a stored blob for the merge above; `{}` on anything odd. */
function safeParse(raw: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}
