/**
 * Google sign-in for external mailboxes.
 *
 * The handshake spans two requests through a third party, so the properties
 * worth pinning are the ones that only hold if the server side is strict: the
 * state row is single-use, expires, and belongs to exactly one user; the
 * `returnTo` cannot leave the site; the INTENT recorded at `start` is the one
 * that executes at `complete` (the callback cannot choose another); a
 * re-authorization cannot land on a different Google account; and the worker
 * gets a live access token for an oauth2 row — or, when the grant is revoked, a
 * refusal plus an `auth_error` the user can act on.
 *
 * Google's token endpoint is stubbed (`vi.stubGlobal('fetch', …)`) with a
 * hand-built `id_token`, so nothing here touches the network.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { encryptSecret } from '../lib/credentialCrypto';
import { clearGoogleAccessTokenCache } from '../mail/external/googleOAuthTokens';
import type { Id } from '../_generated/dataModel';

const sessionMocks = vi.hoisted(() => ({
	getBetterAuthSessionWithRole: vi.fn(),
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = (await vi.importActual('../lib/sessionOrganization')) as {
		hasPermission: (role: string, permission: string) => boolean;
	};
	const fromSession = async () => {
		const s = await sessionMocks.getBetterAuthSessionWithRole();
		if (!s) throw new Error('Not authenticated');
		return { userId: s.userId, role: s.role, activeOrganizationId: s.activeOrganizationId };
	};
	// The session lookup is stubbed, but the ROLE test is not: the real
	// `hasPermission` table decides, so a test that hands the flow an editor
	// exercises the same floor production does.
	const withPermission = async (permission: string) => {
		const s = await fromSession();
		if (!actual.hasPermission(s.role, permission)) {
			throw new Error('Only owners and admins can perform this action');
		}
		return s;
	};
	return {
		...actual,
		getBetterAuthSessionWithRole: sessionMocks.getBetterAuthSessionWithRole,
		requireOrgMember: vi.fn(fromSession),
		getMutationContext: vi.fn(fromSession),
		requireOrgPermission: vi.fn(async (_ctx: unknown, permission: string) =>
			withPermission(permission)
		),
		requireAdminContext: vi.fn(async () => withPermission('organization:manage')),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn(async () => (await fromSession()).userId),
	};
});

const modules = import.meta.glob('../**/*.*s');

const CLIENT_ID = 'client-id.apps.googleusercontent.com';

function setSession(userId: string, role: 'owner' | 'admin' | 'editor' = 'owner', orgId = 'org-1') {
	sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue({
		userId,
		role,
		activeOrganizationId: orgId,
	});
}

async function enableExternal(t: ReturnType<typeof convexTest>) {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			featureFlags: { 'mail.external': true },
			createdAt: Date.now(),
		});
	});
}

/**
 * A Google `id_token` is a JWT whose payload we read (and never verify — see
 * `readVerifiedGoogleEmail`), so a hand-built unsigned one is structurally what
 * the exchange sees.
 */
function idToken(claims: Record<string, unknown>): string {
	const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
	return `header.${payload}.signature`;
}

/** The claim set Google stamps on a healthy `id_token`. */
function claims(overrides: Record<string, unknown> = {}) {
	return {
		aud: CLIENT_ID,
		iss: 'https://accounts.google.com',
		exp: Math.floor(Date.now() / 1000) + 3600,
		email_verified: true,
		...overrides,
	};
}

function googleAccount(email: string, overrides: Record<string, unknown> = {}) {
	return {
		access_token: 'ya29.ACCESS',
		refresh_token: '1//REFRESH',
		expires_in: 3599,
		id_token: idToken(claims({ email })),
		...overrides,
	};
}

/** Stub Google's token endpoint with a queue of JSON bodies. */
function stubToken(...bodies: Record<string, unknown>[]) {
	const calls: URLSearchParams[] = [];
	const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
		calls.push(new URLSearchParams(init.body));
		const body = bodies.length > 1 ? bodies.shift() : bodies[0];
		return { status: 200, json: async () => body } as unknown as Response;
	});
	vi.stubGlobal('fetch', fetchMock);
	return calls;
}

beforeEach(() => {
	vi.stubEnv('INSTANCE_SECRET', 'unit-test-instance-secret-value');
	vi.stubEnv('SITE_URL', 'https://owlat.example/');
	vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', CLIENT_ID);
	vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'client-secret');
	clearGoogleAccessTokenCache();
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('googleOAuth.isConfigured', () => {
	it('reports configured only when BOTH client env vars are set', async () => {
		const t = convexTest(schema, modules);
		setSession('user-A');
		expect(await t.query(api.mail.external.googleOAuth.isConfigured, {})).toEqual({
			configured: true,
		});

		vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', '');
		expect(await t.query(api.mail.external.googleOAuth.isConfigured, {})).toEqual({
			configured: false,
		});
	});
});

describe('googleOAuthActions.start', () => {
	it('builds an authorization URL with PKCE + the Gmail scope and stores one state row', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');

		const { authorizationUrl } = await t.action(api.mail.external.googleOAuthActions.start, {
			intent: { kind: 'connect' },
			returnTo: '/dashboard/postbox/migrate?googleConnected=1',
		});

		const url = new URL(authorizationUrl);
		expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
		expect(url.searchParams.get('scope')).toBe('https://mail.google.com/ openid email');
		expect(url.searchParams.get('access_type')).toBe('offline');
		expect(url.searchParams.get('prompt')).toBe('consent');
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('code_challenge')).toBeTruthy();
		// SITE_URL's trailing slash must not survive into the redirect URI, which
		// has to match Google Cloud Console byte for byte.
		expect(url.searchParams.get('redirect_uri')).toBe(
			'https://owlat.example/oauth/google/callback'
		);

		const rows = await t.run((ctx) => ctx.db.query('externalMailOAuthStates').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]?.state).toBe(url.searchParams.get('state'));
		// The verifier is stored; the CHALLENGE is what travels to Google.
		expect(rows[0]?.codeVerifier).not.toBe(url.searchParams.get('code_challenge'));
		expect(rows[0]?.intent).toEqual({ kind: 'connect' });
	});

	it('refuses a returnTo that could leave the site', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		for (const returnTo of ['//evil.example/', 'https://evil.example/', '/\\evil.example']) {
			await expect(
				t.action(api.mail.external.googleOAuthActions.start, {
					intent: { kind: 'connect' },
					returnTo,
				})
			).rejects.toThrow(/return path/i);
		}
	});

	it('refuses when the instance has no Google OAuth client', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', '');
		await expect(
			t.action(api.mail.external.googleOAuthActions.start, {
				intent: { kind: 'connect' },
				returnTo: '/dashboard',
			})
		).rejects.toThrow(/not configured/i);
	});

	it('refuses a team-inbox or seed intent from a non-admin BEFORE Google is involved', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'editor');

		for (const intent of [
			{ kind: 'connectShared' as const, memberUserIds: [] },
			{ kind: 'connectSeed' as const, seedProvider: 'gmail' as const },
		]) {
			await expect(
				t.action(api.mail.external.googleOAuthActions.start, {
					intent,
					returnTo: '/dashboard/postbox',
				})
			).rejects.toThrow(/owners and admins/i);
		}
		// Nothing was started, so the editor is never sent to Google's consent
		// screen only to be refused on the way back.
		const rows = await t.run((ctx) => ctx.db.query('externalMailOAuthStates').collect());
		expect(rows).toHaveLength(0);
	});

	it('still lets an editor start a PERSONAL connect', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'editor');
		await expect(
			t.action(api.mail.external.googleOAuthActions.start, {
				intent: { kind: 'connect' },
				returnTo: '/dashboard/postbox',
			})
		).resolves.toHaveProperty('authorizationUrl');
	});

	it('keeps at most one live attempt per user', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		await t.action(api.mail.external.googleOAuthActions.start, {
			intent: { kind: 'connect' },
			returnTo: '/dashboard',
		});
		await t.action(api.mail.external.googleOAuthActions.start, {
			intent: { kind: 'connect' },
			returnTo: '/dashboard',
		});
		const rows = await t.run((ctx) => ctx.db.query('externalMailOAuthStates').collect());
		expect(rows).toHaveLength(1);
	});
});

describe('state row lifecycle', () => {
	async function seedState(
		t: ReturnType<typeof convexTest>,
		overrides: Partial<{ userId: string; organizationId: string; expiresAt: number }> = {}
	): Promise<string> {
		const state = `state-${Math.random()}`;
		await t.run(async (ctx) => {
			await ctx.db.insert('externalMailOAuthStates', {
				userId: overrides.userId ?? 'user-A',
				organizationId: overrides.organizationId ?? 'org-1',
				provider: 'google',
				state,
				codeVerifier: 'verifier',
				intent: { kind: 'connect' },
				returnTo: '/dashboard',
				createdAt: Date.now(),
				expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
			});
		});
		return state;
	}

	it('is single use — the second consume finds nothing', async () => {
		const t = convexTest(schema, modules);
		setSession('user-A');
		const state = await seedState(t);
		expect(
			await t.mutation(internal.mail.external.googleOAuth._consumeStateInternal, { state })
		).not.toBeNull();
		expect(
			await t.mutation(internal.mail.external.googleOAuth._consumeStateInternal, { state })
		).toBeNull();
	});

	it('refuses another user’s state and still burns the row', async () => {
		const t = convexTest(schema, modules);
		const state = await seedState(t, { userId: 'user-A' });
		setSession('user-B');
		expect(
			await t.mutation(internal.mail.external.googleOAuth._consumeStateInternal, { state })
		).toBeNull();
		const rows = await t.run((ctx) => ctx.db.query('externalMailOAuthStates').collect());
		expect(rows).toHaveLength(0);
	});

	it('refuses a state row started in a different organization', async () => {
		const t = convexTest(schema, modules);
		const state = await seedState(t, { organizationId: 'org-2' });
		// Same user, but they have switched organizations between the two legs.
		// The intent was authorized against org-2; completing it against org-1
		// would land the mailbox in the wrong tenant.
		setSession('user-A', 'owner', 'org-1');
		expect(
			await t.mutation(internal.mail.external.googleOAuth._consumeStateInternal, { state })
		).toBeNull();
	});

	it('refuses an expired state', async () => {
		const t = convexTest(schema, modules);
		setSession('user-A');
		const state = await seedState(t, { expiresAt: Date.now() - 1 });
		expect(
			await t.mutation(internal.mail.external.googleOAuth._consumeStateInternal, { state })
		).toBeNull();
	});

	it('the cron sweep deletes expired rows and keeps live ones', async () => {
		const t = convexTest(schema, modules);
		setSession('user-A');
		await seedState(t, { userId: 'user-A', expiresAt: Date.now() - 1 });
		await seedState(t, { userId: 'user-B', expiresAt: Date.now() + 60_000 });
		expect(await t.mutation(internal.mail.external.googleOAuth._sweepExpiredInternal, {})).toEqual({
			deleted: 1,
		});
		const rows = await t.run((ctx) => ctx.db.query('externalMailOAuthStates').collect());
		expect(rows).toHaveLength(1);
	});
});

/** Run start → complete for one intent, with Google's response stubbed. */
async function roundTrip(
	t: ReturnType<typeof convexTest>,
	intent: Record<string, unknown>,
	body: Record<string, unknown>,
	returnTo = '/dashboard/postbox'
) {
	const { authorizationUrl } = await t.action(api.mail.external.googleOAuthActions.start, {
		intent: intent as never,
		returnTo,
	});
	const state = new URL(authorizationUrl).searchParams.get('state') as string;
	const calls = stubToken(body);
	const result = await t.action(api.mail.external.googleOAuthActions.complete, {
		code: 'auth-code',
		state,
	});
	return { result, calls };
}

describe('googleOAuthActions.complete', () => {
	it('connects a personal mailbox as an oauth2 row with the Gmail preset', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');

		const { result, calls } = await roundTrip(
			t,
			{ kind: 'connect' },
			googleAccount('Me@Gmail.com')
		);

		expect(result.returnTo).toBe('/dashboard/postbox');
		// The PKCE verifier and the code both reach Google's token endpoint.
		expect(calls[0]?.get('grant_type')).toBe('authorization_code');
		expect(calls[0]?.get('code')).toBe('auth-code');
		expect(calls[0]?.get('code_verifier')).toBeTruthy();

		const account = await t.run(async (ctx) =>
			ctx.db
				.query('externalMailAccounts')
				.withIndex('by_user', (q) => q.eq('userId', 'user-A'))
				.first()
		);
		expect(account?.authMethod).toBe('oauth2');
		expect(account?.oauthProvider).toBe('google');
		expect(account?.imapHost).toBe('imap.gmail.com');
		expect(account?.smtpHost).toBe('smtp.gmail.com');
		expect(account?.imapUsername).toBe('me@gmail.com');

		const mailbox = await t.run((ctx) => ctx.db.get(result.mailboxId));
		expect(mailbox?.address).toBe('me@gmail.com');
	});

	it('never returns the credential fields to the browser', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		const { result } = await roundTrip(t, { kind: 'connect' }, googleAccount('me@gmail.com'));
		expect(Object.keys(result).sort()).toEqual(['mailboxId', 'returnTo']);
	});

	it('explains the missing-refresh-token case instead of storing half a connection', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		const { authorizationUrl } = await t.action(api.mail.external.googleOAuthActions.start, {
			intent: { kind: 'connect' },
			returnTo: '/dashboard',
		});
		const state = new URL(authorizationUrl).searchParams.get('state') as string;
		stubToken(googleAccount('me@gmail.com', { refresh_token: undefined }));

		await expect(
			t.action(api.mail.external.googleOAuthActions.complete, { code: 'c', state })
		).rejects.toThrow(/Third-party access/i);
		const accounts = await t.run((ctx) => ctx.db.query('externalMailAccounts').collect());
		expect(accounts).toHaveLength(0);
	});

	it('refuses a spent state (the callback cannot be replayed)', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		const { authorizationUrl } = await t.action(api.mail.external.googleOAuthActions.start, {
			intent: { kind: 'connect' },
			returnTo: '/dashboard',
		});
		const state = new URL(authorizationUrl).searchParams.get('state') as string;
		stubToken(googleAccount('me@gmail.com'));
		await t.action(api.mail.external.googleOAuthActions.complete, { code: 'c', state });

		await expect(
			t.action(api.mail.external.googleOAuthActions.complete, { code: 'c', state })
		).rejects.toThrow(/expired/i);
	});

	it('refuses an id_token minted for a different client', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		await expect(
			roundTrip(
				t,
				{ kind: 'connect' },
				googleAccount('me@gmail.com', {
					id_token: idToken(claims({ aud: 'someone-else', email: 'me@gmail.com' })),
				})
			)
		).rejects.toThrow(/different application/i);
	});

	it('refuses an unverified Google address', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		await expect(
			roundTrip(
				t,
				{ kind: 'connect' },
				googleAccount('me@gmail.com', {
					id_token: idToken(claims({ email: 'me@gmail.com', email_verified: false })),
				})
			)
		).rejects.toThrow(/verified email/i);
	});

	it('refuses an id_token payload that is not an object', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		// `null` and a bare string both parse as valid JSON: without the shape
		// guard the first claim read throws a TypeError out of the whole action
		// instead of the invalid-input refusal the callback page can show.
		for (const payload of ['null', '"nope"', '42']) {
			await expect(
				roundTrip(
					t,
					{ kind: 'connect' },
					googleAccount('me@gmail.com', {
						id_token: `header.${Buffer.from(payload).toString('base64url')}.signature`,
					})
				)
			).rejects.toThrow(/unreadable sign-in token/i);
		}
	});

	it('refuses an id_token that has already expired', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		await expect(
			roundTrip(
				t,
				{ kind: 'connect' },
				googleAccount('me@gmail.com', {
					id_token: idToken(
						claims({ email: 'me@gmail.com', exp: Math.floor(Date.now() / 1000) - 1 })
					),
				})
			)
		).rejects.toThrow(/expired sign-in token/i);
		expect(await t.run((ctx) => ctx.db.query('externalMailAccounts').collect())).toHaveLength(0);
	});

	it('an update must sign in as the SAME account', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		await roundTrip(t, { kind: 'connect' }, googleAccount('me@gmail.com'));

		await expect(
			roundTrip(t, { kind: 'update' }, googleAccount('someone.else@gmail.com'))
		).rejects.toThrow(/someone.else@gmail.com/);

		// And the matching address rotates the stored envelope in place.
		const before = await t.run(
			async (ctx) => (await ctx.db.query('externalMailAccounts').first())?.secretCiphertext
		);
		await roundTrip(t, { kind: 'update' }, googleAccount('me@gmail.com'));
		const after = await t.run(
			async (ctx) => (await ctx.db.query('externalMailAccounts').first())?.secretCiphertext
		);
		expect(after).not.toBe(before);
	});

	it('dispatches connectSeed to the seed mutation, not the personal one', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'admin');

		await roundTrip(
			t,
			{ kind: 'connectSeed', seedProvider: 'gmail' },
			googleAccount('seed@gmail.com')
		);

		const account = await t.run((ctx) => ctx.db.query('externalMailAccounts').first());
		expect(account?.purpose).toBe('seed');
		expect(account?.seedProvider).toBe('gmail');
		expect(account?.authMethod).toBe('oauth2');
	});

	it('dispatches connectShared to the team-inbox mutation with its roster', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'admin');

		const { result } = await roundTrip(
			t,
			{ kind: 'connectShared', displayName: 'Support', memberUserIds: [] },
			googleAccount('support@gmail.com')
		);

		const mailbox = await t.run((ctx) => ctx.db.get(result.mailboxId));
		expect(mailbox?.scope).toBe('shared');
		const account = await t.run((ctx) => ctx.db.query('externalMailAccounts').first());
		expect(account?.scope).toBe('shared');
		expect(account?.authMethod).toBe('oauth2');
	});
});

describe('credential rotation across auth methods', () => {
	const PASSWORD_ARGS = {
		emailAddress: 'me@gmail.com',
		imapHost: 'imap.gmail.com',
		imapPort: 993,
		isImapSecure: true,
		smtpHost: 'smtp.gmail.com',
		smtpPort: 465,
		isSmtpSecure: true,
		username: 'me@gmail.com',
		password: 'app-password',
	};

	it('an app-password repair of an oauth2 account clears oauthProvider', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		await roundTrip(t, { kind: 'connect' }, googleAccount('me@gmail.com'));
		vi.unstubAllGlobals();

		await t.action(api.mail.external.accountsActions.updateCredentials, PASSWORD_ARGS);

		const account = await t.run((ctx) => ctx.db.query('externalMailAccounts').first());
		expect(account?.authMethod).toBe('password');
		expect(account?.oauthProvider).toBeUndefined();
	});

	it('Google sign-in on a password account flips it to oauth2', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		await t.action(api.mail.external.accountsActions.connect, PASSWORD_ARGS);

		await roundTrip(t, { kind: 'update' }, googleAccount('me@gmail.com'));

		const account = await t.run((ctx) => ctx.db.query('externalMailAccounts').first());
		expect(account?.authMethod).toBe('oauth2');
		expect(account?.oauthProvider).toBe('google');
	});
});

/** The IMAP access token a successful fetch carries, or null. */
function tokenOf(result: {
	kind: string;
	credentials?: { imapAccessToken?: string };
}): string | null {
	return result.kind === 'credentials' ? (result.credentials?.imapAccessToken ?? null) : null;
}

describe('getCredentialsForWorker on an oauth2 row', () => {
	async function seedOAuthAccount(t: ReturnType<typeof convexTest>) {
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

	it('mints an access token for both protocols and leaves the passwords empty', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedOAuthAccount(t);
		const calls = stubToken({ access_token: 'ya29.FRESH', expires_in: 3599 });

		const result = await t.action(internal.mail.external.accountsActions.getCredentialsForWorker, {
			accountId: accountId as Id<'externalMailAccounts'>,
		});

		expect(calls[0]?.get('grant_type')).toBe('refresh_token');
		expect(result.kind).toBe('credentials');
		const creds = result.kind === 'credentials' ? result.credentials : null;
		expect(creds?.imapAccessToken).toBe('ya29.FRESH');
		expect(creds?.smtpAccessToken).toBe('ya29.FRESH');
		expect(creds?.imapPassword).toBe('');
		expect(creds?.smtpPassword).toBe('');
		// The refresh token itself must never leave the backend.
		expect(JSON.stringify(result)).not.toContain('1//REFRESH');
	});

	it('marks the account auth_error and reports auth_revoked when the grant was revoked', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedOAuthAccount(t);
		stubToken({ error: 'invalid_grant' });

		const result = await t.action(internal.mail.external.accountsActions.getCredentialsForWorker, {
			accountId: accountId as Id<'externalMailAccounts'>,
		});

		// The worker reads `auth_revoked` as terminal — it stops instead of
		// retrying, and leaves the message below in place.
		expect(result).toEqual({ kind: 'unavailable', reason: 'auth_revoked' });
		const account = await t.run((ctx) => ctx.db.get(accountId));
		expect(account?.status).toBe('auth_error');
		expect(account?.lastError).toMatch(/Reconnect with Google/i);
	});

	it('reports a transient token-endpoint failure as retryable, leaving the status alone', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedOAuthAccount(t);
		stubToken({ error: 'temporarily_unavailable' });

		const result = await t.action(internal.mail.external.accountsActions.getCredentialsForWorker, {
			accountId: accountId as Id<'externalMailAccounts'>,
		});

		expect(result).toEqual({ kind: 'unavailable', reason: 'refresh_failed' });
		const account = await t.run((ctx) => ctx.db.get(accountId));
		expect(account?.status).toBe('connected');
	});

	it('reports an undecryptable envelope as missing, not as a revoked grant', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedOAuthAccount(t);
		await t.run((ctx) => ctx.db.patch(accountId, { secretCiphertext: 'not-ciphertext' }));

		const result = await t.action(internal.mail.external.accountsActions.getCredentialsForWorker, {
			accountId: accountId as Id<'externalMailAccounts'>,
		});

		expect(result).toEqual({ kind: 'unavailable', reason: 'missing' });
	});

	/**
	 * The warm-isolate token cache is keyed by account AND envelope. Keyed by
	 * account alone, a reconnect would keep being served the PREVIOUS grant's
	 * token for the rest of its hour — the user re-authorizes and the mailbox
	 * still cannot log in.
	 */
	it('serves a cached token for the same envelope but never across a reconnect', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedOAuthAccount(t);
		const calls = stubToken(
			{ access_token: 'ya29.FIRST', expires_in: 3599 },
			{ access_token: 'ya29.SECOND', expires_in: 3599 }
		);

		const first = await t.action(internal.mail.external.accountsActions.getCredentialsForWorker, {
			accountId: accountId as Id<'externalMailAccounts'>,
		});
		const cached = await t.action(internal.mail.external.accountsActions.getCredentialsForWorker, {
			accountId: accountId as Id<'externalMailAccounts'>,
		});
		expect(tokenOf(first)).toBe('ya29.FIRST');
		expect(tokenOf(cached)).toBe('ya29.FIRST');
		expect(calls).toHaveLength(1);

		// Reconnect: a fresh grant re-encrypted into a fresh envelope.
		const rotated = encryptSecret(JSON.stringify({ oauthRefreshToken: '1//SECOND-REFRESH' }));
		await t.run((ctx) =>
			ctx.db.patch(accountId, {
				secretCiphertext: rotated.ciphertext,
				secretIv: rotated.iv,
				secretAuthTag: rotated.authTag,
				secretEnvelopeVersion: rotated.version,
			})
		);

		const afterReconnect = await t.action(
			internal.mail.external.accountsActions.getCredentialsForWorker,
			{ accountId: accountId as Id<'externalMailAccounts'> }
		);
		expect(tokenOf(afterReconnect)).toBe('ya29.SECOND');
		expect(calls).toHaveLength(2);
		expect(calls[1]?.get('refresh_token')).toBe('1//SECOND-REFRESH');
	});
});
