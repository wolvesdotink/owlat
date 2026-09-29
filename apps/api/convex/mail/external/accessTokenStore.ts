/**
 * Durable cache of minted OAuth access tokens (`externalMailAccessTokens`).
 *
 * `refreshGoogleAccessToken` (the `'use node'` half in `googleOAuthTokens.ts`)
 * seals and opens the token; this V8 file only moves the sealed envelope in and
 * out of the table, so no plaintext token ever reaches a query or mutation.
 *
 * The in-memory map in `googleOAuthTokens.ts` stays as the first tier: it is
 * free when Convex reuses a warm isolate. This table is the second tier that
 * survives a cold one, which is the common case for an action called a few
 * times an hour.
 *
 *   Internal: _getStoredAccessToken, _storeAccessToken, _clearStoredAccessToken
 *   Helper:   deleteStoredAccessToken (for the teardown and erasure mutations)
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';

/** The sealed token for an account, or null. Callers still check `sourceIv` and expiry. */
export const _getStoredAccessToken = internalQuery({
	args: { accountId: v.id('externalMailAccounts') },
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query('externalMailAccessTokens')
			.withIndex('by_account', (q) => q.eq('accountId', args.accountId))
			.first(); // bounded: at most one row per account
		if (!row) return null;
		return {
			sourceIv: row.sourceIv,
			ciphertext: row.secretCiphertext,
			iv: row.secretIv,
			authTag: row.secretAuthTag,
			version: row.secretEnvelopeVersion,
			expiresAt: row.expiresAt,
		};
	},
});

/**
 * Upsert the sealed token for an account.
 *
 * Writes nothing unless the account is still live on the SAME refresh-token
 * envelope the token was minted from. The mint ran outside any transaction, so
 * a disconnect (which forgets the credential and deletes this row) or a
 * reconnect may have landed in between; persisting then would leave a token on
 * disk for a connection that no longer exists.
 */
export const _storeAccessToken = internalMutation({
	args: {
		accountId: v.id('externalMailAccounts'),
		sourceIv: v.string(),
		ciphertext: v.string(),
		iv: v.string(),
		authTag: v.string(),
		version: v.number(),
		expiresAt: v.number(),
	},
	handler: async (ctx, args): Promise<{ stored: boolean }> => {
		const account = await ctx.db.get(args.accountId);
		if (
			!account ||
			account.status === 'disconnected' ||
			account.authMethod !== 'oauth2' ||
			account.secretIv !== args.sourceIv
		) {
			return { stored: false };
		}
		const fields = {
			sourceIv: args.sourceIv,
			secretCiphertext: args.ciphertext,
			secretIv: args.iv,
			secretAuthTag: args.authTag,
			secretEnvelopeVersion: args.version,
			expiresAt: args.expiresAt,
			updatedAt: Date.now(),
		};
		const rows = await ctx.db
			.query('externalMailAccessTokens')
			.withIndex('by_account', (q) => q.eq('accountId', args.accountId))
			.take(10); // bounded: one row per account; extras only from a lost race
		const [first, ...extra] = rows;
		if (first) {
			await ctx.db.patch(first._id, fields);
		} else {
			await ctx.db.insert('externalMailAccessTokens', { accountId: args.accountId, ...fields });
		}
		for (const row of extra) await ctx.db.delete(row._id);
		return { stored: true };
	},
});

/** Forget an account's cached token (Google reported the grant revoked). */
export const _clearStoredAccessToken = internalMutation({
	args: { accountId: v.id('externalMailAccounts') },
	handler: async (ctx, args) => {
		await deleteStoredAccessToken(ctx, args.accountId);
	},
});

/** Delete every cached token row for an account. */
export async function deleteStoredAccessToken(
	ctx: MutationCtx,
	accountId: Id<'externalMailAccounts'>
): Promise<void> {
	const rows = await ctx.db
		.query('externalMailAccessTokens')
		.withIndex('by_account', (q) => q.eq('accountId', accountId))
		.take(10); // bounded: one row per account
	for (const row of rows) await ctx.db.delete(row._id);
}
