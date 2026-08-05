/**
 * The Mandrill identity row — every write of it, in one place.
 *
 * Two callers reach these: the sending-domain lifecycle (through the adapter's
 * `writeIdentity` / `clearIdentity`, when a domain's PRIMARY provider is
 * Mandrill) and the relay sweep in `domains/mandrillRelayMutations.ts` (when
 * Mandrill is a coexisting RELAY on someone else's domain). Both produce the
 * same row for the same (org, domain), so the proof the router reads does not
 * depend on which door the identity came through.
 *
 * Its own file so the WRITE rules — what a failed call may overwrite, and what
 * it may not — are pinned in one readable place rather than spread across an
 * adapter method and a mutation handler.
 */

import { CURRENT_RELAY_IDENTITY_PROVIDER_DETAILS_VERSION } from '../../../lib/constants';
import { getSingletonOrganizationId } from '../../../lib/sessionOrganization';
import {
	MANDRILL_UNAVAILABLE_RETRY_MS,
	buildMandrillProviderDetails,
	nextMandrillCheckDueAt,
} from './identity';
import type { Doc, Id } from '../../../_generated/dataModel';
import type { MutationCtx } from '../../../_generated/server';
import type { MandrillIdentity } from '../types';

/**
 * The row for one (organization, domain).
 *
 * Keyed by domain NAME rather than by `domainId`, because that is how the
 * generic table is keyed (D7): a relay identity can exist for a domain whose
 * primary `domains` row belongs to another provider entirely, and the
 * enqueue-path proof looks it up by envelope From domain with no id in hand.
 */
export async function loadMandrillRow(
	ctx: MutationCtx,
	organizationId: string,
	domain: string
): Promise<Doc<'sendingDomainRelayIdentities'> | null> {
	return await ctx.db
		.query('sendingDomainRelayIdentities')
		.withIndex('by_org_domain_provider', (q) =>
			q.eq('organizationId', organizationId).eq('domain', domain).eq('providerKind', 'mandrill')
		)
		.first();
}

/** The canonical (lowercased) sending domain name for a `domains` row id. */
export async function resolveDomainName(
	ctx: MutationCtx,
	domainId: Id<'domains'>
): Promise<string | null> {
	const domain = await ctx.db.get(domainId);
	return domain ? domain.domain.toLowerCase() : null;
}

/**
 * Upsert one OBSERVED identity. Application-enforces the one-row-per
 * (org, domain, kind) invariant, exactly as the two frozen sibling tables do
 * for their own key.
 *
 * `lastCheckedAt` comes from the identity's own `checkedAt`, not from
 * `Date.now()`: it dates the EVIDENCE, and the relay proof's freshness bound
 * reads it. Stamping the write time would let a row written long after the call
 * it describes look fresher than the fact it holds.
 */
export async function upsertMandrillIdentity(
	ctx: MutationCtx,
	domainName: string,
	identity: MandrillIdentity
): Promise<void> {
	const organizationId = await getSingletonOrganizationId(ctx);
	const domain = domainName.toLowerCase();
	const existing = await loadMandrillRow(ctx, organizationId, domain);
	const now = Date.now();
	const fields = {
		status: identity.status,
		spf: identity.spf,
		dkim: identity.dkim,
		providerDetails: buildMandrillProviderDetails(identity),
		providerDetailsVersion: CURRENT_RELAY_IDENTITY_PROVIDER_DETAILS_VERSION,
		lastCheckedAt: identity.checkedAt,
		nextCheckDueAt: nextMandrillCheckDueAt(identity.status, identity.checkedAt),
		updatedAt: now,
	};
	if (existing) {
		await ctx.db.patch(existing._id, fields);
		return;
	}
	await ctx.db.insert('sendingDomainRelayIdentities', {
		organizationId,
		domain,
		providerKind: 'mandrill',
		...fields,
		createdAt: now,
	});
}

/**
 * A credential Mandrill rejected (or one this deployment does not have).
 *
 * `failed` is written, and the SPF/DKIM verdicts are left EXACTLY as they were:
 * a bad API key is not evidence that the operator's DNS stopped being valid,
 * and overwriting the verdicts would make the domain-setup screen tell them to
 * republish records that are fine. `lastCheckedAt` is not advanced either —
 * nothing was checked — so the relay proof ages out on schedule instead of
 * being kept alive by failures.
 *
 * No row of its own is created when none exists: a deployment with no Mandrill
 * identity and a bad key has nothing to say about a domain, and inventing a
 * `failed` row would put a red state on a domain nobody ever connected.
 */
export async function markMandrillIdentityFailed(
	ctx: MutationCtx,
	domainName: string,
	error: string,
	now: number
): Promise<void> {
	const organizationId = await getSingletonOrganizationId(ctx);
	const existing = await loadMandrillRow(ctx, organizationId, domainName.toLowerCase());
	if (!existing) return;
	await ctx.db.patch(existing._id, {
		status: 'failed',
		providerDetails: JSON.stringify({
			...(existing.providerDetails ? safeParse(existing.providerDetails) : {}),
			kind: 'mandrill',
			lastError: error,
		}),
		providerDetailsVersion: CURRENT_RELAY_IDENTITY_PROVIDER_DETAILS_VERSION,
		nextCheckDueAt: nextMandrillCheckDueAt('failed', now),
		updatedAt: now,
	});
}

/**
 * Mandrill did not answer. The identity is left UNTOUCHED except for when to
 * ask again — an outage is evidence of nothing, and in particular it must not
 * refresh `lastCheckedAt`, or a long enough outage would keep a stale proof
 * alive forever by never being able to confirm it.
 */
export async function scheduleMandrillRetry(
	ctx: MutationCtx,
	domainName: string,
	now: number
): Promise<void> {
	const organizationId = await getSingletonOrganizationId(ctx);
	const existing = await loadMandrillRow(ctx, organizationId, domainName.toLowerCase());
	if (!existing) return;
	await ctx.db.patch(existing._id, {
		nextCheckDueAt: now + MANDRILL_UNAVAILABLE_RETRY_MS,
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
