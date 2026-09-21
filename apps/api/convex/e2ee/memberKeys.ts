/**
 * The MEMBER-facing half of Sealed Mail (plan idea 55) — the v8 (query/mutation)
 * plane behind the "Your mail is sealed" card in Preferences.
 *
 * Everything Sealed Mail exposed until now was admin-only: the instance settings
 * page, the key backfill, the recovery-kit export. A member could see sealed
 * badges on their mail and had no way to answer the two questions that follow
 * from them — "does MY address actually have a key?" and "what happens to my
 * sealed mail if this server is rebuilt?". This module answers exactly those,
 * and nothing more:
 *
 *   - `getOwnSealedMailStatus` (authed member) — for each address the caller
 *     sends as, whether an active sealing key exists and its PUBLIC fingerprint;
 *   - `isOwnSendableAddress` (internal) — the ownership half of the recovery-kit
 *     gate, which the `'use node'` export action cannot evaluate itself;
 *   - `recordRecoveryKitFailure` / `isRecoveryKitThrottled` (internal) — the rate
 *     limit in front of the recovery-kit password re-prompt.
 *
 * SECURITY INVARIANT, inherited from `e2ee/keys.ts`: nothing here returns
 * `sealedPrivateKey` or any private material. Fingerprints and public key
 * presence only. The one private-key egress remains
 * `e2ee/lifecycleNode.ts:exportOwnRecoveryKit`, behind `e2ee/recoveryKitGate.ts`.
 *
 * Nothing here uses `authedIdentityMutation` (a locked Sealed-Mail rule).
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery, type QueryCtx } from '../_generated/server';
import { authedQuery } from '../lib/authedFunctions';
import { isFeatureEnabled } from '../lib/featureFlags';
import { getBetterAuthSession } from '../lib/sessionOrganization';
import { normalizeEmail } from '@owlat/shared';
import { resolveAllowedFromAddressesForCtx } from '../mail/identities';

/**
 * Failed recovery-kit re-authentications allowed inside {@link REAUTH_WINDOW_MS}
 * before the export refuses to even check the password. Deliberately tighter
 * than the SMTP/IMAP limiter next door (`mail/authRateLimit.ts`): this is a
 * human typing their own password into a settings page, not a mail client
 * retrying, so five attempts a minute is generous and a thousand guesses an hour
 * is not on the table.
 */
const REAUTH_FAILURE_LIMIT = 5;
const REAUTH_WINDOW_MS = 15 * 60 * 1000;

/** The `mailAuthFailures.scope` this module owns. */
const REAUTH_SCOPE = 'recovery-kit' as const;

/** Cap the fan-out of the per-user address walk; nobody sends as this many addresses. */
const MAX_OWN_MAILBOXES = 50;

/**
 * Every address the given user may send as: the canonical address of each ACTIVE
 * mailbox they own, plus every alias targeting it — the exact set
 * `mail/identities.ts` authorises at send time, so "my address" means the same
 * thing here as it does in the composer.
 *
 * Shared mailboxes are included when the user OWNS the row; an explicit
 * `mailboxMembers` grant is not enough. Membership of a team inbox lets someone
 * read and send from it — it does not make its private key theirs to take home.
 */
async function ownSendableAddresses(ctx: QueryCtx, userId: string): Promise<string[]> {
	const mailboxes = await ctx.db
		.query('mailboxes')
		.withIndex('by_user', (q) => q.eq('userId', userId))
		.filter((q) => q.eq(q.field('status'), 'active'))
		.take(MAX_OWN_MAILBOXES);
	const addresses = new Set<string>();
	for (const mailbox of mailboxes) {
		for (const address of await resolveAllowedFromAddressesForCtx(ctx, mailbox._id)) {
			addresses.add(normalizeEmail(address));
		}
	}
	return Array.from(addresses);
}

/**
 * Does this caller send as `address`? The ownership half of the recovery-kit
 * gate (`e2ee/recoveryKitGate.ts` step 2). Internal, and identity-scoped: a
 * `'use node'` action inherits its caller's identity through `ctx.runQuery`, so
 * this reads the SESSION user rather than accepting a user id as an argument —
 * an argument would make the whole gate bypassable by anyone who can call an
 * internal function.
 */
export const isOwnSendableAddress = internalQuery({
	args: { address: v.string() },
	returns: v.boolean(),
	handler: async (ctx, args): Promise<boolean> => {
		const session = await getBetterAuthSession(ctx);
		if (!session) return false;
		const address = normalizeEmail(args.address);
		if (!address.includes('@')) return false;
		return (await ownSendableAddresses(ctx, session.userId)).includes(address);
	},
});

/**
 * Is this caller currently locked out of the recovery-kit password re-prompt?
 * Counts only `recovery-kit` failures, so a member fumbling this prompt cannot
 * lock their own mail client out of SMTP submission (and vice versa) — the two
 * limiters share a table, never a budget.
 */
export const isRecoveryKitThrottled = internalQuery({
	args: { address: v.string() },
	returns: v.boolean(),
	handler: async (ctx, args): Promise<boolean> => {
		const cutoff = Date.now() - REAUTH_WINDOW_MS;
		const failures = await ctx.db
			.query('mailAuthFailures')
			.withIndex('by_address_and_time', (q) =>
				q.eq('address', normalizeEmail(args.address)).gte('occurredAt', cutoff)
			)
			.collect(); // bounded: one address's auth failures inside the window
		return failures.filter((f) => f.scope === REAUTH_SCOPE).length >= REAUTH_FAILURE_LIMIT;
	},
});

/** Record a failed recovery-kit re-authentication. Feeds {@link isRecoveryKitThrottled}. */
export const recordRecoveryKitFailure = internalMutation({
	args: { address: v.string() },
	returns: v.null(),
	handler: async (ctx, args): Promise<null> => {
		await ctx.db.insert('mailAuthFailures', {
			address: normalizeEmail(args.address),
			scope: REAUTH_SCOPE,
			occurredAt: Date.now(),
		});
		return null;
	},
});

/**
 * The caller's OWN sealing-key status: one row per address they send as, with
 * whether an active key exists and — when it does — its PUBLIC fingerprint.
 *
 * This is what lets the Preferences card say something true instead of
 * reassuring: an address with no key is shown as having none, because a member
 * whose mail is NOT being sealed deserves to find that out here rather than
 * infer it from a badge that never appears.
 *
 * `enabled` reports the instance flag rather than throwing on it, so the card can
 * self-hide instead of erroring on an instance that never turned Sealed Mail on.
 */
// all-members: self-scoped — returns only the caller's own addresses (resolved
// from the session user id, never from an argument) and PUBLIC fingerprints.
export const getOwnSealedMailStatus = authedQuery({
	args: {},
	returns: v.object({
		enabled: v.boolean(),
		addresses: v.array(
			v.object({
				address: v.string(),
				hasKey: v.boolean(),
				fingerprint: v.union(v.string(), v.null()),
			})
		),
	}),
	handler: async (ctx, _args, session) => {
		if (!(await isFeatureEnabled(ctx, 'sealedMail'))) return { enabled: false, addresses: [] };
		const addresses = await ownSendableAddresses(ctx, session.userId);
		const rows = await Promise.all(
			addresses.map(async (address) => {
				const key = await ctx.db
					.query('keyVault')
					.withIndex('by_address', (q) => q.eq('address', address))
					.filter((q) => q.eq(q.field('isActive'), true))
					.first();
				return {
					address,
					hasKey: key !== null,
					fingerprint: key?.fingerprint ?? null,
				};
			})
		);
		return { enabled: true, addresses: rows.sort((a, b) => a.address.localeCompare(b.address)) };
	},
});
