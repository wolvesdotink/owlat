/**
 * The Mandrill identity row — this kind's three writes, each one a call to the
 * shared write rules with the two things a kind owns filled in.
 *
 * Two callers reach these: the sending-domain lifecycle (through the adapter's
 * `writeIdentity` / `clearIdentity`, when a domain's PRIMARY provider is
 * Mandrill) and the relay sweep in `domains/mandrillRelayMutations.ts` (when
 * Mandrill is a coexisting RELAY on someone else's domain). Both produce the
 * same row for the same (org, domain), so the proof the router reads does not
 * depend on which door the identity came through.
 *
 * THE RULES THEMSELVES LIVE IN `../relayIdentityPersistence.ts` — what a failed
 * call may overwrite, what an outage may not, and why `lastCheckedAt` dates the
 * evidence rather than the write. They are shared because the bundled plugin
 * tier writes the same table under the same rules, and two copies of a rule is
 * two copies that can drift. What stays here is what is true of MANDRILL: its
 * cadence table and the shape of its `providerDetails` blob.
 */

import {
	loadRelayIdentityRow,
	markRelayIdentityFailed,
	scheduleRelayIdentityRetry,
	upsertRelayIdentityRow,
} from '../relayIdentityPersistence';
import { parseStoredProviderDetails } from '../relayIdentityProviderDetails';
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
 * generic table is keyed (Mandrill plan D7): a relay identity can exist for a domain whose
 * primary `domains` row belongs to another provider entirely, and the
 * enqueue-path proof looks it up by envelope From domain with no id in hand.
 */
export async function loadMandrillRow(
	ctx: MutationCtx,
	organizationId: string,
	domain: string
): Promise<Doc<'sendingDomainRelayIdentities'> | null> {
	return await loadRelayIdentityRow(ctx, organizationId, 'mandrill', domain);
}

/** The canonical (lowercased) sending domain name for a `domains` row id. */
export async function resolveDomainName(
	ctx: MutationCtx,
	domainId: Id<'domains'>
): Promise<string | null> {
	const domain = await ctx.db.get(domainId);
	return domain ? domain.domain.toLowerCase() : null;
}

/** Upsert one OBSERVED identity, under Mandrill's cadence and blob. */
export async function upsertMandrillIdentity(
	ctx: MutationCtx,
	domainName: string,
	identity: MandrillIdentity
): Promise<void> {
	await upsertRelayIdentityRow(ctx, {
		kind: 'mandrill',
		domain: domainName,
		status: identity.status,
		spf: identity.spf,
		dkim: identity.dkim,
		providerDetails: buildMandrillProviderDetails(identity),
		checkedAt: identity.checkedAt,
		nextCheckDueAt: nextMandrillCheckDueAt(identity.status, identity.checkedAt),
	});
}

/**
 * A credential Mandrill rejected (or one this deployment does not have). The
 * reason is merged into what is stored so a `failed` row still carries the
 * account facts a successful call recorded.
 */
export async function markMandrillIdentityFailed(
	ctx: MutationCtx,
	domainName: string,
	error: string,
	now: number
): Promise<void> {
	await markRelayIdentityFailed(ctx, {
		kind: 'mandrill',
		domain: domainName,
		now,
		nextCheckDueAt: nextMandrillCheckDueAt('failed', now),
		buildProviderDetails: (stored) =>
			JSON.stringify({
				...parseStoredProviderDetails(stored),
				kind: 'mandrill',
				lastError: error,
			}),
	});
}

/** Mandrill did not answer: only when to ask again moves. */
export async function scheduleMandrillRetry(
	ctx: MutationCtx,
	domainName: string,
	now: number
): Promise<void> {
	await scheduleRelayIdentityRetry(ctx, {
		kind: 'mandrill',
		domain: domainName,
		now,
		nextCheckDueAt: now + MANDRILL_UNAVAILABLE_RETRY_MS,
	});
}
