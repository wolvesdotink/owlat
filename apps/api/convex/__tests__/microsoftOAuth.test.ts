/**
 * Microsoft sign-in for external mailboxes.
 *
 * The same handshake properties as Google sign-in (single-use, user- and
 * org-bound state; a same-site `returnTo`; the intent pinned at `start`), plus
 * what is Microsoft's own: the tenant is held to the characters a tenant can
 * contain, the `id_token` must name a directory the instance admits, both mail
 * scopes must be granted, the server preset follows the account kind, and the
 * refresh token Microsoft rotates on every refresh is kept current without
 * rewriting the account row on every mint.
 *
 * The token endpoint is stubbed (`vi.stubGlobal('fetch', …)`) with hand-built
 * `id_token`s, so nothing here touches the network or a real Microsoft tenant.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { decryptSecret, encryptSecret } from '../lib/credentialCrypto';
import { clearAccessTokenCache } from '../mail/external/oauthTokenShared';
import type { Id } from '../_generated/dataModel';

const sessionMocks = vi.hoisted(() => ({
	getBetterAuthSessionWithRole: vi.fn(),
}));

const dnsMocks = vi.hoisted(() => ({ resolveMx: vi.fn() }));
vi.mock('node:dns/promises', () => ({ default: dnsMocks, ...dnsMocks }));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = (await vi.importActual('../lib/sessionOrganization')) as {
		hasPermission: (role: string, permission: string) => boolean;
	};
	const fromSession = async () => {
		const s = await sessionMocks.getBetterAuthSessionWithRole();
		if (!s) throw new Error('Not authenticated');
		return { userId: s.userId, role: s.role, activeOrganizationId: s.activeOrganizationId };
	};
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

const CLIENT_ID = '00000000-0000-0000-0000-00000000c1d0';
const WORK_TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
const CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const MAIL_SCOPE =
	'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send';

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

function idToken(claims: Record<string, unknown>): string {
	const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
	return `header.${payload}.signature`;
}

/** The claim set Microsoft stamps on a healthy v2.0 `id_token`. */
function claims(tenantId: string, overrides: Record<string, unknown> = {}) {
	return {
		aud: CLIENT_ID,
		iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
		tid: tenantId,
		exp: Math.floor(Date.now() / 1000) + 3600,
		...overrides,
	};
}

function microsoftAccount(
	email: string,
	tenantId = WORK_TENANT,
	overrides: Record<string, unknown> = {},
	claimOverrides: Record<string, unknown> = {}
) {
	return {
		access_token: 'eyJ.ACCESS',
		refresh_token: 'M.R3_REFRESH',
		expires_in: 3599,
		scope: `${MAIL_SCOPE} openid email profile`,
		id_token: idToken(claims(tenantId, { email, ...claimOverrides })),
		...overrides,
	};
}

/** Stub the token endpoint with a queue of JSON bodies; records URL and form. */
function stubToken(...bodies: Record<string, unknown>[]) {
	const calls: { url: string; body: URLSearchParams }[] = [];
	const fetchMock = vi.fn(async (url: string, init: { body: string }) => {
		calls.push({ url, body: new URLSearchParams(init.body) });
		const body = bodies.length > 1 ? bodies.shift() : bodies[0];
		return { status: 200, json: async () => body } as unknown as Response;
	});
	vi.stubGlobal('fetch', fetchMock);
	return calls;
}

beforeEach(() => {
	vi.stubEnv('INSTANCE_SECRET', 'unit-test-instance-secret-value');
	vi.stubEnv('SITE_URL', 'https://owlat.example/');
	vi.stubEnv('MICROSOFT_OAUTH_CLIENT_ID', CLIENT_ID);
	vi.stubEnv('MICROSOFT_OAUTH_CLIENT_SECRET', 'client-secret');
	vi.stubEnv('MICROSOFT_OAUTH_TENANT', '');
	clearAccessTokenCache();
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function start(
	t: ReturnType<typeof convexTest>,
	intent: Record<string, unknown> = { kind: 'connect' },
	returnTo = '/dashboard/postbox'
) {
	const { authorizationUrl } = await t.action(api.mail.external.microsoftOAuthActions.start, {
		intent: intent as never,
		returnTo,
	});
	return new URL(authorizationUrl);
}

/** Run start → complete for one intent, with Microsoft's response stubbed. */
async function roundTrip(
	t: ReturnType<typeof convexTest>,
	intent: Record<string, unknown>,
	body: Record<string, unknown>
) {
	const url = await start(t, intent);
	const calls = stubToken(body);
	const result = await t.action(api.mail.external.microsoftOAuthActions.complete, {
		code: 'auth-code',
		state: url.searchParams.get('state') as string,
	});
	return { result, calls };
}

async function firstAccount(t: ReturnType<typeof convexTest>) {
	return await t.run(async (ctx) => ctx.db.query('externalMailAccounts').first());
}

function openEnvelope(account: {
	secretCiphertext?: string;
	secretIv?: string;
	secretAuthTag?: string;
	secretEnvelopeVersion?: number;
}): { oauthRefreshToken?: string; oauthRefreshTokenStoredAt?: number } {
	return JSON.parse(
		decryptSecret({
			ciphertext: account.secretCiphertext as string,
			iv: account.secretIv as string,
			authTag: account.secretAuthTag as string,
			version: account.secretEnvelopeVersion as number,
		})
	);
}

describe('microsoftOAuth.isConfigured', () => {
	it('needs the client id and secret, and a tenant that is a tenant', async () => {
		const t = convexTest(schema, modules);
		setSession('user-A');
		const configured = () => t.query(api.mail.external.microsoftOAuth.isConfigured, {});
		expect(await configured()).toEqual({ configured: true });

		vi.stubEnv('MICROSOFT_OAUTH_TENANT', 'contoso.onmicrosoft.com');
		expect(await configured()).toEqual({ configured: true });

		// A tenant goes into the authority URL's path; anything that could move
		// the request elsewhere hides the button instead.
		for (const tenant of ['common/../evil', 'evil.example?x=', 'user@evil.example']) {
			vi.stubEnv('MICROSOFT_OAUTH_TENANT', tenant);
			expect(await configured()).toEqual({ configured: false });
		}

		vi.stubEnv('MICROSOFT_OAUTH_TENANT', '');
		vi.stubEnv('MICROSOFT_OAUTH_CLIENT_SECRET', '');
		expect(await configured()).toEqual({ configured: false });
	});
});

describe('microsoftOAuthActions.start', () => {
	it('builds a PKCE authorization URL for the mail scopes and stores a Microsoft state row', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');

		const url = await start(t);

		expect(url.origin + url.pathname).toBe(
			'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
		);
		expect(url.searchParams.get('scope')).toBe(`${MAIL_SCOPE} offline_access openid email profile`);
		expect(url.searchParams.get('response_type')).toBe('code');
		expect(url.searchParams.get('response_mode')).toBe('query');
		expect(url.searchParams.get('prompt')).toBe('select_account');
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('code_challenge')).toBeTruthy();
		expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
		expect(url.searchParams.get('redirect_uri')).toBe(
			'https://owlat.example/oauth/microsoft/callback'
		);

		const rows = await t.run((ctx) => ctx.db.query('externalMailOAuthStates').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]?.provider).toBe('microsoft');
		expect(rows[0]?.state).toBe(url.searchParams.get('state'));
		expect(rows[0]?.codeVerifier).not.toBe(url.searchParams.get('code_challenge'));
	});

	it('uses the configured tenant as the authority', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		vi.stubEnv('MICROSOFT_OAUTH_TENANT', WORK_TENANT);

		const url = await start(t);
		expect(url.pathname).toBe(`/${WORK_TENANT}/oauth2/v2.0/authorize`);
	});

	it('refuses a returnTo that could leave the site', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		for (const returnTo of ['//evil.example/', 'https://evil.example/', '/\\evil.example']) {
			await expect(start(t, { kind: 'connect' }, returnTo)).rejects.toThrow(/return path/i);
		}
	});

	it('refuses when the instance has no Microsoft app, or its tenant is not a tenant', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		vi.stubEnv('MICROSOFT_OAUTH_TENANT', 'evil.example/path');
		await expect(start(t)).rejects.toThrow(/MICROSOFT_OAUTH_TENANT/);

		vi.stubEnv('MICROSOFT_OAUTH_TENANT', '');
		vi.stubEnv('MICROSOFT_OAUTH_CLIENT_ID', '');
		await expect(start(t)).rejects.toThrow(/not configured/i);
	});

	it('refuses a team-inbox intent from a non-admin before Microsoft is involved', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A', 'editor');
		await expect(start(t, { kind: 'connectShared', memberUserIds: [] })).rejects.toThrow();
		const rows = await t.run((ctx) => ctx.db.query('externalMailOAuthStates').collect());
		expect(rows).toHaveLength(0);
	});
});

describe('state rows are bound to their provider', () => {
	it('a Google callback cannot consume a Microsoft state, and burns it', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		const state = (await start(t)).searchParams.get('state') as string;

		expect(
			await t.mutation(internal.mail.external.googleOAuth._consumeStateInternal, { state })
		).toBeNull();
		expect(
			await t.mutation(internal.mail.external.microsoftOAuth._consumeStateInternal, { state })
		).toBeNull();
	});

	it('a Microsoft callback cannot consume a Google state', async () => {
		const t = convexTest(schema, modules);
		setSession('user-A');
		await t.run(async (ctx) => {
			await ctx.db.insert('externalMailOAuthStates', {
				userId: 'user-A',
				organizationId: 'org-1',
				provider: 'google',
				state: 'google-state',
				codeVerifier: 'verifier',
				intent: { kind: 'connect' },
				returnTo: '/dashboard',
				createdAt: Date.now(),
				expiresAt: Date.now() + 60_000,
			});
		});
		expect(
			await t.mutation(internal.mail.external.microsoftOAuth._consumeStateInternal, {
				state: 'google-state',
			})
		).toBeNull();
	});

	it('refuses another user’s Microsoft state', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		const state = (await start(t)).searchParams.get('state') as string;
		setSession('user-B');
		expect(
			await t.mutation(internal.mail.external.microsoftOAuth._consumeStateInternal, { state })
		).toBeNull();
	});
});

describe('microsoftOAuthActions.complete', () => {
	it('connects a work account as an oauth2 Microsoft row with the Microsoft 365 hosts', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');

		const { result, calls } = await roundTrip(
			t,
			{ kind: 'connect' },
			microsoftAccount('Ada@Contoso.com')
		);

		expect(result.returnTo).toBe('/dashboard/postbox');
		expect(calls[0]?.url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
		expect(calls[0]?.body.get('grant_type')).toBe('authorization_code');
		expect(calls[0]?.body.get('code')).toBe('auth-code');
		expect(calls[0]?.body.get('code_verifier')).toBeTruthy();
		expect(calls[0]?.body.get('redirect_uri')).toBe(
			'https://owlat.example/oauth/microsoft/callback'
		);

		const account = await firstAccount(t);
		expect(account?.authMethod).toBe('oauth2');
		expect(account?.oauthProvider).toBe('microsoft');
		expect(account?.imapHost).toBe('outlook.office365.com');
		expect(account?.imapPort).toBe(993);
		expect(account?.smtpHost).toBe('smtp.office365.com');
		expect(account?.smtpPort).toBe(587);
		expect(account?.isSmtpSecure).toBe(false);
		expect(account?.imapUsername).toBe('ada@contoso.com');

		const secret = openEnvelope(account ?? {});
		expect(secret.oauthRefreshToken).toBe('M.R3_REFRESH');
		expect(typeof secret.oauthRefreshTokenStoredAt).toBe('number');
		expect(JSON.stringify(result)).not.toContain('M.R3_REFRESH');
	});

	it('gives a personal account the Outlook.com submission host', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		await roundTrip(t, { kind: 'connect' }, microsoftAccount('me@outlook.com', CONSUMER_TENANT));
		expect((await firstAccount(t))?.smtpHost).toBe('smtp-mail.outlook.com');
	});

	it('falls back to preferred_username when the token has no email claim', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		await roundTrip(
			t,
			{ kind: 'connect' },
			microsoftAccount(
				'',
				WORK_TENANT,
				{},
				{ email: undefined, preferred_username: 'Ada@Contoso.com' }
			)
		);
		expect((await firstAccount(t))?.imapUsername).toBe('ada@contoso.com');
	});

	it.each([
		['a token for a different application', { aud: 'someone-else' }, /different application/],
		[
			'an issuer that does not name the token’s directory',
			{ iss: `https://login.microsoftonline.com/${CONSUMER_TENANT}/v2.0` },
			/unexpected issuer/,
		],
		['a token without a directory id', { tid: undefined }, /unexpected issuer/],
		['an expired token', { exp: Math.floor(Date.now() / 1000) - 10 }, /expired/],
		['no usable address', { email: 'not-an-address', preferred_username: 'ada' }, /email address/],
	])('refuses %s and stores nothing', async (_label, claimOverrides, message) => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		await expect(
			roundTrip(
				t,
				{ kind: 'connect' },
				microsoftAccount('ada@contoso.com', WORK_TENANT, {}, claimOverrides)
			)
		).rejects.toThrow(message);
		expect(await firstAccount(t)).toBeNull();
	});

	it('refuses a directory the configured tenant does not admit', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');

		vi.stubEnv('MICROSOFT_OAUTH_TENANT', 'organizations');
		await expect(
			roundTrip(t, { kind: 'connect' }, microsoftAccount('me@outlook.com', CONSUMER_TENANT))
		).rejects.toThrow(/does not accept/);

		vi.stubEnv('MICROSOFT_OAUTH_TENANT', WORK_TENANT);
		await expect(
			roundTrip(
				t,
				{ kind: 'connect' },
				microsoftAccount('eve@fabrikam.com', '11111111-2222-3333-4444-555555555555')
			)
		).rejects.toThrow(/does not accept/);
		expect(await firstAccount(t)).toBeNull();
	});

	it('refuses a grant that does not cover both reading and sending mail', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		await expect(
			roundTrip(
				t,
				{ kind: 'connect' },
				microsoftAccount('ada@contoso.com', WORK_TENANT, {
					scope: 'https://outlook.office.com/IMAP.AccessAsUser.All openid',
				})
			)
		).rejects.toThrow(/reading and sending/);
		expect(await firstAccount(t)).toBeNull();
	});

	it('explains a missing refresh token instead of storing half a connection', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		await expect(
			roundTrip(
				t,
				{ kind: 'connect' },
				microsoftAccount('ada@contoso.com', WORK_TENANT, { refresh_token: undefined })
			)
		).rejects.toThrow(/long-lived/);
		expect(await firstAccount(t)).toBeNull();
	});

	it('refuses a spent state, so the callback cannot be replayed', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		const url = await start(t);
		const state = url.searchParams.get('state') as string;
		stubToken(microsoftAccount('ada@contoso.com'));
		await t.action(api.mail.external.microsoftOAuthActions.complete, { code: 'c', state });
		await expect(
			t.action(api.mail.external.microsoftOAuthActions.complete, { code: 'c', state })
		).rejects.toThrow(/expired/);
	});

	it('an update must sign in as the same account, and pre-selects it', async () => {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		await roundTrip(t, { kind: 'connect' }, microsoftAccount('ada@contoso.com'));

		const url = await start(t, { kind: 'update' });
		expect(url.searchParams.get('login_hint')).toBe('ada@contoso.com');

		await expect(
			roundTrip(t, { kind: 'update' }, microsoftAccount('eve@contoso.com'))
		).rejects.toThrow(/eve@contoso.com/);
	});
});

describe('getCredentialsForWorker on a Microsoft oauth2 row', () => {
	const DAY_MS = 24 * 60 * 60 * 1000;

	async function seedMicrosoftAccount(
		t: ReturnType<typeof convexTest>,
		secret: Record<string, unknown> = { oauthRefreshToken: 'M.R3_STORED' }
	) {
		const envelope = encryptSecret(JSON.stringify(secret));
		return await t.run(async (ctx) => {
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: 'user-A',
				organizationId: 'org-1',
				address: 'ada@contoso.com',
				domain: 'contoso.com',
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
				imapHost: 'outlook.office365.com',
				imapPort: 993,
				isImapSecure: true,
				smtpHost: 'smtp.office365.com',
				smtpPort: 587,
				isSmtpSecure: false,
				authMethod: 'oauth2',
				oauthProvider: 'microsoft',
				imapUsername: 'ada@contoso.com',
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

	function fetchCredentials(
		t: ReturnType<typeof convexTest>,
		accountId: Id<'externalMailAccounts'>
	) {
		return t.action(internal.mail.external.accountsActions.getCredentialsForWorker, { accountId });
	}

	it('mints an access token at Microsoft’s endpoint for both protocols', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedMicrosoftAccount(t, {
			oauthRefreshToken: 'M.R3_STORED',
			oauthRefreshTokenStoredAt: Date.now(),
		});
		const calls = stubToken({
			access_token: 'eyJ.FRESH',
			refresh_token: 'M.R3_NEXT',
			expires_in: 3599,
		});

		const result = await fetchCredentials(t, accountId);

		expect(calls[0]?.url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
		expect(calls[0]?.body.get('grant_type')).toBe('refresh_token');
		expect(calls[0]?.body.get('refresh_token')).toBe('M.R3_STORED');
		expect(calls[0]?.body.get('scope')).toBe(`${MAIL_SCOPE} offline_access`);
		const creds = result.kind === 'credentials' ? result.credentials : null;
		expect(creds?.imapAccessToken).toBe('eyJ.FRESH');
		expect(creds?.smtpAccessToken).toBe('eyJ.FRESH');
		expect(creds?.imapPassword).toBe('');
		expect(JSON.stringify(result)).not.toContain('M.R3_');

		// A refresh token stored moments ago is not rewritten for the newer one.
		const account = await t.run((ctx) => ctx.db.get(accountId));
		expect(openEnvelope(account ?? {}).oauthRefreshToken).toBe('M.R3_STORED');
	});

	it('replaces a week-old refresh token with the rotated one and keeps serving from cache', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedMicrosoftAccount(t, {
			oauthRefreshToken: 'M.R3_STORED',
			oauthRefreshTokenStoredAt: Date.now() - 8 * DAY_MS,
		});
		const before = await t.run((ctx) => ctx.db.get(accountId));
		const calls = stubToken({
			access_token: 'eyJ.FRESH',
			refresh_token: 'M.R3_NEXT',
			expires_in: 3599,
		});

		expect((await fetchCredentials(t, accountId)).kind).toBe('credentials');

		const after = await t.run((ctx) => ctx.db.get(accountId));
		expect(after?.secretIv).not.toBe(before?.secretIv);
		const secret = openEnvelope(after ?? {});
		expect(secret.oauthRefreshToken).toBe('M.R3_NEXT');
		expect(secret.oauthRefreshTokenStoredAt).toBeGreaterThan(Date.now() - DAY_MS);
		expect(after?.status).toBe('connected');

		// The minted token was cached under the NEW envelope, which is the one the
		// next fetch reads: no second trip to Microsoft.
		const second = await fetchCredentials(t, accountId);
		expect(second.kind === 'credentials' ? second.credentials.imapAccessToken : null).toBe(
			'eyJ.FRESH'
		);
		expect(calls).toHaveLength(1);
	});

	it('rotates an envelope from before the timestamp existed', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedMicrosoftAccount(t, { oauthRefreshToken: 'M.R3_STORED' });
		stubToken({ access_token: 'eyJ.FRESH', refresh_token: 'M.R3_NEXT', expires_in: 3599 });
		await fetchCredentials(t, accountId);
		const account = await t.run((ctx) => ctx.db.get(accountId));
		expect(openEnvelope(account ?? {}).oauthRefreshToken).toBe('M.R3_NEXT');
	});

	it.each(['invalid_grant', 'interaction_required'])(
		'parks the account on auth_error and reports auth_revoked on %s',
		async (error) => {
			const t = convexTest(schema, modules);
			const accountId = await seedMicrosoftAccount(t);
			stubToken({ error });

			expect(await fetchCredentials(t, accountId)).toEqual({
				kind: 'unavailable',
				reason: 'auth_revoked',
			});
			const account = await t.run((ctx) => ctx.db.get(accountId));
			expect(account?.status).toBe('auth_error');
			expect(account?.lastError).toMatch(/Reconnect with Microsoft/);
		}
	);

	it('reports any other refusal as retryable and leaves the status alone', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedMicrosoftAccount(t);
		stubToken({ error: 'invalid_client' });

		expect(await fetchCredentials(t, accountId)).toEqual({
			kind: 'unavailable',
			reason: 'refresh_failed',
		});
		expect((await t.run((ctx) => ctx.db.get(accountId)))?.status).toBe('connected');
	});
});

describe('_rotateRefreshTokenInternal', () => {
	it('writes only over the envelope it was minted from', async () => {
		const t = convexTest(schema, modules);
		const original = encryptSecret(JSON.stringify({ oauthRefreshToken: 'M.R3_STORED' }));
		const accountId = await t.run(async (ctx) => {
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: 'user-A',
				organizationId: 'org-1',
				address: 'ada@contoso.com',
				domain: 'contoso.com',
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
				imapHost: 'outlook.office365.com',
				imapPort: 993,
				isImapSecure: true,
				smtpHost: 'smtp.office365.com',
				smtpPort: 587,
				isSmtpSecure: false,
				authMethod: 'oauth2',
				oauthProvider: 'microsoft',
				imapUsername: 'ada@contoso.com',
				secretCiphertext: original.ciphertext,
				secretIv: original.iv,
				secretAuthTag: original.authTag,
				secretEnvelopeVersion: original.version,
				status: 'connected',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		const next = encryptSecret(JSON.stringify({ oauthRefreshToken: 'M.R3_NEXT' }));
		const rotate = (expectedIv: string) =>
			t.mutation(internal.mail.external.accessTokenStore._rotateRefreshTokenInternal, {
				accountId,
				expectedIv,
				ciphertext: next.ciphertext,
				iv: next.iv,
				authTag: next.authTag,
				version: next.version,
			});

		// A reconnect landed in between: the envelope is no longer the one minted from.
		expect(await rotate('some-other-iv')).toEqual({ rotated: false });
		expect((await t.run((ctx) => ctx.db.get(accountId)))?.secretIv).toBe(original.iv);

		expect(await rotate(original.iv)).toEqual({ rotated: true });
		expect((await t.run((ctx) => ctx.db.get(accountId)))?.secretIv).toBe(next.iv);

		// A disconnected account keeps its credential forgotten.
		await t.run((ctx) => ctx.db.patch(accountId, { status: 'disconnected' }));
		expect(await rotate(next.iv)).toEqual({ rotated: false });
	});
});

describe('microsoftOAuthActions.isMicrosoftHosted', () => {
	async function hosted(email: string) {
		const t = convexTest(schema, modules);
		await enableExternal(t);
		setSession('user-A');
		return await t.action(api.mail.external.microsoftOAuthActions.isMicrosoftHosted, { email });
	}

	beforeEach(() => {
		dnsMocks.resolveMx.mockReset();
	});

	it('knows Microsoft’s consumer domains without a lookup', async () => {
		expect(await hosted('me@Hotmail.com')).toEqual({ hosted: true });
		expect(dnsMocks.resolveMx).not.toHaveBeenCalled();
	});

	it('recognises a Microsoft 365 domain by its MX', async () => {
		dnsMocks.resolveMx.mockResolvedValue([
			{ exchange: 'contoso-com.mail.protection.outlook.com', priority: 0 },
		]);
		expect(await hosted('ada@contoso.com')).toEqual({ hosted: true });
		expect(dnsMocks.resolveMx).toHaveBeenCalledWith('contoso.com');
	});

	it('answers false for another provider, a look-alike host, or a failed lookup', async () => {
		dnsMocks.resolveMx.mockResolvedValueOnce([{ exchange: 'aspmx.l.google.com', priority: 1 }]);
		expect(await hosted('ada@example.org')).toEqual({ hosted: false });

		dnsMocks.resolveMx.mockResolvedValueOnce([
			{ exchange: 'mail.protection.outlook.com.evil.example', priority: 1 },
		]);
		expect(await hosted('ada@example.org')).toEqual({ hosted: false });

		dnsMocks.resolveMx.mockRejectedValueOnce(Object.assign(new Error('nx'), { code: 'ENOTFOUND' }));
		expect(await hosted('ada@missing.example')).toEqual({ hosted: false });
	});

	it('looks nothing up without a Microsoft app or a well-formed domain', async () => {
		expect(await hosted('ada@')).toEqual({ hosted: false });
		expect(await hosted('ada@exa mple.com')).toEqual({ hosted: false });
		vi.stubEnv('MICROSOFT_OAUTH_CLIENT_SECRET', '');
		expect(await hosted('ada@contoso.com')).toEqual({ hosted: false });
		expect(dnsMocks.resolveMx).not.toHaveBeenCalled();
	});
});
