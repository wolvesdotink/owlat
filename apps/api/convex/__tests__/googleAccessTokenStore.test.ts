/**
 * The sealed access-token row behind `getCredentialsForWorker` (plan E5).
 *
 * Before it existed, every credential fetch on a cold isolate asked Google for a
 * new access token: every worker connect and every /send through a Gmail
 * account paid a token round trip. These tests pin the cache's properties: the
 * token is stored sealed, a cold isolate reuses it until a minute before it
 * expires, it never outlives the grant it came from, and every path that
 * forgets the grant forgets the token too.
 *
 * Google's token endpoint is stubbed, so nothing here touches the network.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { encryptSecret } from '../lib/credentialCrypto';
import { clearGoogleAccessTokenCache } from '../mail/external/googleOAuthTokens';
import { stopExternalAccountSync } from '../mail/external/accountTeardown';
import type { Id } from '../_generated/dataModel';

const modules = import.meta.glob('../**/*.*s');

type AccountId = Id<'externalMailAccounts'>;

/** Stub Google's token endpoint with a queue of JSON bodies; returns the request log. */
function stubToken(...bodies: Record<string, unknown>[]) {
	const calls: URLSearchParams[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: { body: string }) => {
			calls.push(new URLSearchParams(init.body));
			const body = bodies.length > 1 ? bodies.shift() : bodies[0];
			return { status: 200, json: async () => body } as unknown as Response;
		})
	);
	return calls;
}

async function seedOAuthAccount(t: ReturnType<typeof convexTest>): Promise<AccountId> {
	const envelope = encryptSecret(JSON.stringify({ oauthRefreshToken: '1//REFRESH' }));
	return await t.run(async (ctx) => {
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user-A',
			organizationId: 'org-1',
			address: 'me@gmail.com',
			domain: 'gmail.com',
			status: 'active',
			usedBytes: 0,
			uidValidity: Date.now(),
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		return await ctx.db.insert('externalMailAccounts', {
			userId: 'user-A',
			organizationId: 'org-1',
			mailboxId,
			imapHost: 'imap.gmail.com',
			imapPort: 993,
			isImapSecure: true,
			smtpHost: 'smtp.gmail.com',
			smtpPort: 465,
			isSmtpSecure: true,
			authMethod: 'oauth2',
			oauthProvider: 'google',
			imapUsername: 'me@gmail.com',
			secretCiphertext: envelope.ciphertext,
			secretIv: envelope.iv,
			secretAuthTag: envelope.authTag,
			secretEnvelopeVersion: envelope.version,
			status: 'connected',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

async function fetchToken(t: ReturnType<typeof convexTest>, accountId: AccountId) {
	const result = await t.action(internal.mail.external.accountsActions.getCredentialsForWorker, {
		accountId,
	});
	return result.kind === 'credentials' ? (result.credentials.imapAccessToken ?? null) : result;
}

function storedRows(t: ReturnType<typeof convexTest>) {
	return t.run((ctx) => ctx.db.query('externalMailAccessTokens').collect());
}

beforeEach(() => {
	vi.stubEnv('INSTANCE_SECRET', 'unit-test-instance-secret-value');
	vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'client-id.apps.googleusercontent.com');
	vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'client-secret');
	clearGoogleAccessTokenCache();
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('stored Google access tokens', () => {
	it('stores the minted token sealed and serves it to a cold isolate without asking Google again', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedOAuthAccount(t);
		const calls = stubToken(
			{ access_token: 'ya29.FIRST', expires_in: 3599 },
			{ access_token: 'ya29.SECOND', expires_in: 3599 }
		);

		expect(await fetchToken(t, accountId)).toBe('ya29.FIRST');
		const rows = await storedRows(t);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.accountId).toBe(accountId);
		// Sealed: the plaintext token is nowhere in the row.
		expect(JSON.stringify(rows[0])).not.toContain('ya29.FIRST');
		expect(rows[0]?.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);

		// A cold isolate: the in-memory tier is gone, the row is not.
		clearGoogleAccessTokenCache();
		expect(await fetchToken(t, accountId)).toBe('ya29.FIRST');
		expect(calls).toHaveLength(1);
	});

	it('mints a new token once the stored one is within a minute of expiring', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedOAuthAccount(t);
		const calls = stubToken(
			{ access_token: 'ya29.SHORT', expires_in: 30 },
			{ access_token: 'ya29.NEXT', expires_in: 3599 }
		);

		expect(await fetchToken(t, accountId)).toBe('ya29.SHORT');
		clearGoogleAccessTokenCache();
		expect(await fetchToken(t, accountId)).toBe('ya29.NEXT');
		expect(calls).toHaveLength(2);
		// Replaced in place, not appended.
		const rows = await storedRows(t);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);
	});

	it('never serves a stored token minted from a previous grant', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedOAuthAccount(t);
		const calls = stubToken(
			{ access_token: 'ya29.OLD-GRANT', expires_in: 3599 },
			{ access_token: 'ya29.NEW-GRANT', expires_in: 3599 }
		);
		expect(await fetchToken(t, accountId)).toBe('ya29.OLD-GRANT');

		// Reconnect: a fresh grant re-sealed under a fresh IV.
		const rotated = encryptSecret(JSON.stringify({ oauthRefreshToken: '1//NEW-REFRESH' }));
		await t.run((ctx) =>
			ctx.db.patch(accountId, {
				secretCiphertext: rotated.ciphertext,
				secretIv: rotated.iv,
				secretAuthTag: rotated.authTag,
				secretEnvelopeVersion: rotated.version,
			})
		);
		clearGoogleAccessTokenCache();

		expect(await fetchToken(t, accountId)).toBe('ya29.NEW-GRANT');
		expect(calls).toHaveLength(2);
		expect(calls[1]?.get('refresh_token')).toBe('1//NEW-REFRESH');
		const rows = await storedRows(t);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.sourceIv).toBe(rotated.iv);
	});

	it('treats an unreadable stored token as a miss and mints a new one', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedOAuthAccount(t);
		const calls = stubToken(
			{ access_token: 'ya29.FIRST', expires_in: 3599 },
			{ access_token: 'ya29.SECOND', expires_in: 3599 }
		);
		await fetchToken(t, accountId);
		await t.run(async (ctx) => {
			const row = await ctx.db.query('externalMailAccessTokens').first();
			if (row) await ctx.db.patch(row._id, { secretCiphertext: 'tampered' });
		});
		clearGoogleAccessTokenCache();

		expect(await fetchToken(t, accountId)).toBe('ya29.SECOND');
		expect(calls).toHaveLength(2);
	});

	it('forgets the stored token when Google reports the grant revoked', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedOAuthAccount(t);
		stubToken({ access_token: 'ya29.SHORT', expires_in: 30 }, { error: 'invalid_grant' });
		await fetchToken(t, accountId);
		expect(await storedRows(t)).toHaveLength(1);
		clearGoogleAccessTokenCache();

		expect(await fetchToken(t, accountId)).toEqual({
			kind: 'unavailable',
			reason: 'auth_revoked',
		});
		expect(await storedRows(t)).toHaveLength(0);
	});

	it('disconnecting forgets the stored token, and a mint that raced the disconnect is not stored', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedOAuthAccount(t);
		stubToken({ access_token: 'ya29.LIVE', expires_in: 3599 });
		await fetchToken(t, accountId);
		const sourceIv = (await t.run((ctx) => ctx.db.get(accountId)))?.secretIv ?? '';
		expect(await storedRows(t)).toHaveLength(1);

		await t.run(async (ctx) => {
			const account = await ctx.db.get(accountId);
			if (account)
				await stopExternalAccountSync(ctx, account, { now: Date.now(), reason: 'member' });
		});
		expect(await storedRows(t)).toHaveLength(0);

		// A mint that started before the disconnect lands after it.
		const sealed = encryptSecret('ya29.LATE');
		const result = await t.mutation(internal.mail.external.accessTokenStore._storeAccessToken, {
			accountId,
			sourceIv,
			ciphertext: sealed.ciphertext,
			iv: sealed.iv,
			authTag: sealed.authTag,
			version: sealed.version,
			expiresAt: Date.now() + 3_600_000,
		});
		expect(result).toEqual({ stored: false });
		expect(await storedRows(t)).toHaveLength(0);
	});
});
