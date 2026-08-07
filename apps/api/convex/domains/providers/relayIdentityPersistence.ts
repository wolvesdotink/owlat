/**
 * THE WRITE RULES FOR `sendingDomainRelayIdentities`, STATED ONCE — what a call
 * that produced a verdict writes, what a rejected credential may overwrite, and
 * what an outage may not.
 *
 * Every kind after MTA and SES shares this one table (D7), and until this file
 * existed each of them also carried its own copy of the same four operations:
 * Mandrill's `mandrill/persistence.ts` and the bundled plugin tier's
 * `plugin/persistence.ts` were the same upsert, the same failure patch and the
 * same retry patch with a different literal in the middle. THAT IS THE
 * DUPLICATION THAT MATTERS, because the rules are not cosmetic: the next
 * revision of "a failure may not advance `lastCheckedAt`" landing in one copy
 * and not the other would leave two relay tiers reading one table under two
 * definitions of what a proof is.
 *
 * WHAT EACH ADAPTER STILL OWNS is everything that is a fact about its provider
 * rather than about the row: the cadence (`nextCheckDueAt`, computed by the
 * caller from its own interval table) and the shape of its `providerDetails`
 * blob (built by the caller, since it is the one versioned per-provider payload
 * the table deliberately keeps opaque).
 */

import { CURRENT_RELAY_IDENTITY_PROVIDER_DETAILS_VERSION } from '../../lib/constants';
import { getSingletonOrganizationId } from '../../lib/sessionOrganization';
import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';

/** One published record's stored verdict, exactly as the table holds it. */
type StoredRecordVerdict = Doc<'sendingDomainRelayIdentities'>['spf'];

/**
 * The row for one (organization, domain, kind).
 *
 * Keyed by domain NAME rather than by `domainId`, because that is how the
 * generic table is keyed: a relay identity can exist for a domain whose primary
 * `domains` row belongs to another provider entirely, and the enqueue-path proof
 * looks it up by envelope From domain with no id in hand.
 */
export async function loadRelayIdentityRow(
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

/** One observation, as the row records it. */
export interface RelayIdentityObservationWrite {
	readonly kind: string;
	readonly domain: string;
	readonly status: Doc<'sendingDomainRelayIdentities'>['status'];
	readonly spf: StoredRecordVerdict;
	readonly dkim: StoredRecordVerdict;
	/** The adapter's versioned blob, already serialized. */
	readonly providerDetails: string;
	/** When the OBSERVATION was made, not when this write happens. */
	readonly checkedAt: number;
	/** When to ask again, from the adapter's own cadence table. */
	readonly nextCheckDueAt: number;
}

/**
 * Upsert one OBSERVED identity. Application-enforces the one-row-per
 * (org, domain, kind) invariant, exactly as the two frozen sibling tables do for
 * their own key.
 *
 * `lastCheckedAt` comes from the caller's `checkedAt`, not from `Date.now()`: it
 * dates the EVIDENCE, and the relay proof's freshness bound reads it. Stamping
 * the write time would let a row written long after the call it describes look
 * fresher than the fact it holds.
 */
export async function upsertRelayIdentityRow(
	ctx: MutationCtx,
	write: RelayIdentityObservationWrite
): Promise<void> {
	const organizationId = await getSingletonOrganizationId(ctx);
	const domain = write.domain.toLowerCase();
	const existing = await loadRelayIdentityRow(ctx, organizationId, write.kind, domain);
	const now = Date.now();
	const fields = {
		status: write.status,
		spf: write.spf,
		dkim: write.dkim,
		providerDetails: write.providerDetails,
		providerDetailsVersion: CURRENT_RELAY_IDENTITY_PROVIDER_DETAILS_VERSION,
		lastCheckedAt: write.checkedAt,
		nextCheckDueAt: write.nextCheckDueAt,
		updatedAt: now,
	};
	if (existing) {
		await ctx.db.patch(existing._id, fields);
		return;
	}
	await ctx.db.insert('sendingDomainRelayIdentities', {
		organizationId,
		domain,
		providerKind: write.kind,
		...fields,
		createdAt: now,
	});
}

/**
 * A credential the provider rejected (or one this deployment does not have).
 *
 * `failed` is written, and the SPF/DKIM verdicts are left EXACTLY as they were:
 * a bad API key is not evidence that the operator's DNS stopped being valid, and
 * overwriting the verdicts would make the domain screen tell them to republish
 * records that are fine. `lastCheckedAt` is not advanced either — nothing was
 * checked — so the relay proof ages out on schedule instead of being kept alive
 * by failures.
 *
 * No row of its own is created when none exists: a deployment with no identity
 * at this relay and a bad key has nothing to say about a domain, and inventing a
 * `failed` row would put a red state on a domain nobody ever connected.
 *
 * The blob is the ADAPTER's: `buildProviderDetails` is handed whatever is stored
 * today so a failure can carry its reason without discarding the DNS facts a
 * successful call recorded.
 */
export async function markRelayIdentityFailed(
	ctx: MutationCtx,
	params: {
		readonly kind: string;
		readonly domain: string;
		readonly now: number;
		readonly nextCheckDueAt: number;
		readonly buildProviderDetails: (stored: string | undefined) => string;
	}
): Promise<void> {
	const organizationId = await getSingletonOrganizationId(ctx);
	const existing = await loadRelayIdentityRow(
		ctx,
		organizationId,
		params.kind,
		params.domain.toLowerCase()
	);
	if (!existing) return;
	await ctx.db.patch(existing._id, {
		status: 'failed',
		providerDetails: params.buildProviderDetails(existing.providerDetails),
		providerDetailsVersion: CURRENT_RELAY_IDENTITY_PROVIDER_DETAILS_VERSION,
		nextCheckDueAt: params.nextCheckDueAt,
		updatedAt: params.now,
	});
}

/**
 * The call told us NOTHING (the provider is down, timed out, answered in a shape
 * we could not read, or was never made because the contribution is no longer
 * authorized). The identity is left UNTOUCHED except for when to ask again.
 *
 * In particular it must not refresh `lastCheckedAt`, or a long enough outage
 * would keep a stale proof alive forever by never being able to confirm it; and
 * it must not touch the verdicts, which are still the last thing anyone actually
 * observed.
 */
export async function scheduleRelayIdentityRetry(
	ctx: MutationCtx,
	params: {
		readonly kind: string;
		readonly domain: string;
		readonly now: number;
		readonly nextCheckDueAt: number;
	}
): Promise<void> {
	const organizationId = await getSingletonOrganizationId(ctx);
	const existing = await loadRelayIdentityRow(
		ctx,
		organizationId,
		params.kind,
		params.domain.toLowerCase()
	);
	if (!existing) return;
	await ctx.db.patch(existing._id, {
		nextCheckDueAt: params.nextCheckDueAt,
		updatedAt: params.now,
	});
}

/**
 * Best-effort read of a stored blob, for an adapter merging a failure reason
 * into what it already holds; `{}` on anything odd.
 */
export function parseStoredProviderDetails(raw: string | undefined): Record<string, unknown> {
	if (raw === undefined) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}
