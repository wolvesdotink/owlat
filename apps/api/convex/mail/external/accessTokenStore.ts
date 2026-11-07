/**
 * Durable cache of minted OAuth access tokens (`externalMailAccessTokens`).
 *
 * The `'use node'` refresh paths (`googleOAuthTokens.ts`, `microsoftOAuthTokens.ts`,
 * through `oauthTokenShared.ts`) seal and open the token; this V8 file only
 * moves the sealed envelope in and out of the table, so no plaintext token ever
 * reaches a query or mutation.
 *
 * The in-memory map in `oauthTokenShared.ts` stays as the first tier: it is
 * free when Convex reuses a warm isolate. This table is the second tier that
 * survives a cold one, which is the common case for an action called a few
 * times an hour.
 *
 *   Internal: _getStoredAccessToken, _storeAccessToken, _clearStoredAccessToken,
 *             _rotateRefreshTokenInternal
 *   Helper:   deleteStoredAccessToken (for the teardown and erasure mutations)
 */

import { v } from 'convex/values';
import { internalQuery, type MutationCtx, type QueryCtx } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import type { Doc, Id } from '../../_generated/dataModel';

/**
 * Which token a row holds: absent for the mail token, 'graph' for a Microsoft
 * Graph one (see the table's comment in `schema/mailAccounts.ts`).
 */
export const accessTokenAudienceValidator = v.optional(v.literal('graph'));
export type AccessTokenAudience = 'graph' | undefined;

/** An account's rows for one audience; extras only come from a lost race. */
async function rowsForAudience(
	ctx: QueryCtx | MutationCtx,
	accountId: Id<'externalMailAccounts'>,
	audience: AccessTokenAudience
): Promise<Doc<'externalMailAccessTokens'>[]> {
	const rows = await ctx.db
		.query('externalMailAccessTokens')
		.withIndex('by_account', (q) => q.eq('accountId', accountId))
		.take(10); // bounded: one row per account and audience
	return rows.filter((row) => row.audience === audience);
}

/** The sealed token for an account, or null. Callers still check `sourceIv` and expiry. */
export const _getStoredAccessToken = internalQuery({
	args: { accountId: v.id('externalMailAccounts'), audience: accessTokenAudienceValidator },
	handler: async (ctx, args) => {
		const [row] = await rowsForAudience(ctx, args.accountId, args.audience);
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
		audience: accessTokenAudienceValidator,
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
		const [first, ...extra] = await rowsForAudience(ctx, args.accountId, args.audience);
		if (first) {
			await ctx.db.patch(first._id, fields);
		} else {
			await ctx.db.insert('externalMailAccessTokens', {
				accountId: args.accountId,
				...(args.audience ? { audience: args.audience } : {}),
				...fields,
			});
		}
		for (const row of extra) await ctx.db.delete(row._id);
		return { stored: true };
	},
});

/** Forget every cached token of an account (the provider reported the grant revoked). */
export const _clearStoredAccessToken = internalMutation({
	args: { accountId: v.id('externalMailAccounts') },
	handler: async (ctx, args) => {
		await deleteStoredAccessToken(ctx, args.accountId);
	},
});

/**
 * Replace an oauth2 account's sealed refresh-token envelope with a newer one the
 * provider issued on refresh (Microsoft rotates its refresh tokens).
 *
 * Compare-and-swap on the envelope's IV: the refresh ran outside any
 * transaction, so a reconnect (a different grant), a disconnect (the credential
 * forgotten) or a concurrent rotation may have landed in between, and each of
 * those must win. Only the four envelope columns change; the account's status
 * and connection settings are not this write's business. The cached access
 * tokens keyed to the old IV are dropped with it.
 */
export const _rotateRefreshTokenInternal = internalMutation({
	args: {
		accountId: v.id('externalMailAccounts'),
		expectedIv: v.string(),
		ciphertext: v.string(),
		iv: v.string(),
		authTag: v.string(),
		version: v.number(),
	},
	handler: async (ctx, args): Promise<{ rotated: boolean }> => {
		const account = await ctx.db.get(args.accountId);
		if (
			!account ||
			account.status === 'disconnected' ||
			account.authMethod !== 'oauth2' ||
			account.secretIv !== args.expectedIv
		) {
			return { rotated: false };
		}
		await ctx.db.patch(args.accountId, {
			secretCiphertext: args.ciphertext,
			secretIv: args.iv,
			secretAuthTag: args.authTag,
			secretEnvelopeVersion: args.version,
		});
		await deleteStoredAccessToken(ctx, args.accountId);
		return { rotated: true };
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
		.take(10); // bounded: one row per account and audience
	for (const row of rows) await ctx.db.delete(row._id);
}
