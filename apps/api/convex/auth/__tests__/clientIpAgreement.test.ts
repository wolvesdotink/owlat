import { execFileSync } from 'node:child_process';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getClientIp } from '../../lib/publicRateLimit';
import type * as RuntimeLog from '../../lib/runtimeLog';
import { resolveBetterAuthIpAddressConfig, withVerifiedClientIp } from '../ipAddress';

/**
 * GHSA-vq6p-3982-9fmm: the public-endpoint limiter and BetterAuth's sign-in /
 * password-reset limiter must agree, for every RATE_LIMIT_TRUSTED_PROXY mode,
 * on whether a forwarded client-IP header is trusted. The sign-in side runs a
 * real BetterAuth instance behind the same wrapper the `/api/auth/*` route uses,
 * and reads the limiter key it actually produced.
 */

vi.mock('../../lib/runtimeLog', async (importOriginal) => {
	const actual = await importOriginal<typeof RuntimeLog>();
	return { ...actual, logWarn: vi.fn() };
});

afterEach(() => {
	vi.unstubAllEnvs();
});

const SECRET = 'proxy-shared-secret';
const CF_IP = '203.0.113.10';
const REAL_IP = '203.0.113.20';
const XFF_IP = '203.0.113.30';
// Under NODE_ENV=test BetterAuth substitutes this when no client IP resolves;
// in production the same case is its shared `no-trusted-ip` bucket.
const SHARED_BUCKET = '127.0.0.1';

function recordingStorage() {
	const counts = new Map<string, number>();
	const keys: string[] = [];
	return {
		keys,
		storage: {
			get: async () => null,
			set: async () => {},
			consume: async (key: string, rule: { window: number; max: number }) => {
				keys.push(key);
				const count = (counts.get(key) ?? 0) + 1;
				counts.set(key, count);
				return count <= rule.max
					? { allowed: true, retryAfter: null }
					: { allowed: false, retryAfter: rule.window };
			},
		},
	};
}

/** A BetterAuth instance configured from the current env, as the route serves it. */
function authRoute() {
	const { keys, storage } = recordingStorage();
	const auth = betterAuth({
		baseURL: 'https://deployment.convex.site',
		secret: 'test-secret-with-enough-entropy-0123456789',
		database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
		emailAndPassword: { enabled: true, sendResetPassword: async () => {} },
		rateLimit: { enabled: true, customStorage: storage },
		advanced: { ipAddress: resolveBetterAuthIpAddressConfig() },
		logger: { disabled: true },
	});
	return { keys, handler: withVerifiedClientIp(auth).handler };
}

function authRequest(path: string, headers: Record<string, string>, body: unknown): Request {
	return new Request(`https://deployment.convex.site/api/auth${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify(body),
	});
}

const signIn = (headers: Record<string, string>) =>
	authRequest('/sign-in/email', headers, {
		email: 'nobody@example.com',
		password: 'not-the-password-1234',
	});

const keyIp = (key: string | undefined) => key?.split('|')[0];

describe('public and sign-in limiters agree on forwarded-header trust', () => {
	const modes = [undefined, 'cloudflare', 'xrealip', 'xforwarded', 'leftmost'];
	const configuredSecrets = [undefined, SECRET];
	const presentedSecrets = [undefined, SECRET, 'not-the-secret'];
	const expectedIp: Record<string, string> = {
		cloudflare: CF_IP,
		xrealip: REAL_IP,
		xforwarded: XFF_IP,
	};

	for (const mode of modes) {
		for (const configured of configuredSecrets) {
			for (const presented of presentedSecrets) {
				it(`mode=${mode ?? 'unset'} secret=${configured ? 'set' : 'unset'} presented=${presented ?? 'none'}`, async () => {
					vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', mode ?? '');
					vi.stubEnv('RATE_LIMIT_PROXY_SECRET', configured ?? '');
					const headers: Record<string, string> = {
						'CF-Connecting-IP': CF_IP,
						'X-Real-IP': REAL_IP,
						'X-Forwarded-For': XFF_IP,
						...(presented ? { 'X-Owlat-Proxy-Secret': presented } : {}),
					};

					const publicIp = getClientIp(
						new Request('https://deployment.convex.site/forms/abc', { headers })
					);
					const route = authRoute();
					await route.handler(signIn(headers));
					const loginIp = keyIp(route.keys[0]);

					const publicTrusted = publicIp !== 'unknown';
					const loginTrusted = loginIp !== SHARED_BUCKET;
					expect(loginTrusted).toBe(publicTrusted);
					if (publicTrusted) {
						expect(publicIp).toBe(expectedIp[mode!]);
						expect(loginIp).toBe(publicIp);
					}
					const verified = configured !== undefined && presented === configured;
					const shouldTrust =
						mode === 'xforwarded' || ((mode === 'cloudflare' || mode === 'xrealip') && verified);
					expect(publicTrusted).toBe(shouldTrust);
				});
			}
		}
	}
});

describe('sign-in and reset throttle with an unverified forwarded header', () => {
	for (const mode of ['cloudflare', 'xrealip'] as const) {
		const header = mode === 'cloudflare' ? 'CF-Connecting-IP' : 'X-Real-IP';

		for (const [label, configured, presented] of [
			['no proxy secret configured', undefined, undefined],
			['proxy secret not presented', SECRET, undefined],
			['wrong proxy secret presented', SECRET, 'not-the-secret'],
		] as const) {
			it(`${mode}, ${label}: a new ${header} per attempt still hits the limiter`, async () => {
				vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', mode);
				vi.stubEnv('RATE_LIMIT_PROXY_SECRET', configured ?? '');
				const route = authRoute();
				const statuses: number[] = [];
				for (let attempt = 1; attempt <= 4; attempt += 1) {
					const response = await route.handler(
						signIn({
							[header]: `198.51.100.${attempt}`,
							...(presented ? { 'X-Owlat-Proxy-Secret': presented } : {}),
						})
					);
					statuses.push(response.status);
				}
				expect(new Set(route.keys).size).toBe(1);
				expect(statuses.slice(0, 3)).not.toContain(429);
				expect(statuses[3]).toBe(429);
			});
		}

		it(`${mode}: password-reset requests share one bucket without the proxy secret`, async () => {
			vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', mode);
			vi.stubEnv('RATE_LIMIT_PROXY_SECRET', SECRET);
			const route = authRoute();
			const statuses: number[] = [];
			for (let attempt = 1; attempt <= 4; attempt += 1) {
				const response = await route.handler(
					authRequest(
						'/request-password-reset',
						{ [header]: `198.51.100.${attempt}` },
						{ email: 'nobody@example.com', redirectTo: '/reset-password' }
					)
				);
				statuses.push(response.status);
			}
			expect(new Set(route.keys).size).toBe(1);
			expect(statuses.slice(0, 3)).not.toContain(429);
			expect(statuses[3]).toBe(429);
		});

		it(`${mode}: a verified proxy secret keeps per-client buckets`, async () => {
			vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', mode);
			vi.stubEnv('RATE_LIMIT_PROXY_SECRET', SECRET);
			const route = authRoute();
			const statuses: number[] = [];
			for (let attempt = 1; attempt <= 4; attempt += 1) {
				const response = await route.handler(
					signIn({ [header]: `198.51.100.${attempt}`, 'X-Owlat-Proxy-Secret': SECRET })
				);
				statuses.push(response.status);
			}
			expect(route.keys.map(keyIp)).toEqual([
				'198.51.100.1',
				'198.51.100.2',
				'198.51.100.3',
				'198.51.100.4',
			]);
			expect(statuses).not.toContain(429);
		});
	}
});

describe('advisory when an unverified header is removed', () => {
	it('logs once per instance, and not for a verified request', async () => {
		vi.resetModules();
		const { withVerifiedClientIp: wrap } = await import('../ipAddress');
		const { logWarn } = await import('../../lib/runtimeLog');
		vi.mocked(logWarn).mockClear();
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', 'xrealip');
		vi.stubEnv('RATE_LIMIT_PROXY_SECRET', SECRET);
		const seen: Array<string | null> = [];
		const route = wrap({
			handler: async (request: Request) => {
				seen.push(request.headers.get('X-Real-IP'));
				return new Response(null, { status: 204 });
			},
		});

		await route.handler(signIn({ 'X-Real-IP': REAL_IP, 'X-Owlat-Proxy-Secret': SECRET }));
		expect(logWarn).not.toHaveBeenCalled();
		await route.handler(signIn({ 'X-Real-IP': REAL_IP }));
		await route.handler(signIn({ 'X-Real-IP': REAL_IP, 'X-Owlat-Proxy-Secret': 'wrong' }));

		expect(seen).toEqual([REAL_IP, null, null]);
		expect(logWarn).toHaveBeenCalledTimes(1);
		expect(String(vi.mocked(logWarn).mock.calls[0]?.[0])).toContain('web app origin');
	});
});

/**
 * The fix relies on BetterAuth still limiting a request for which no client IP
 * resolves, keyed `no-trusted-ip|<path>` (better-auth 1.6.25:
 * `resolveRateLimitConfig` in dist/api/rate-limiter/index.mjs, and `getIp` in
 * @better-auth/core dist/utils/ip.mjs). Under NODE_ENV=test `getIp` returns
 * 127.0.0.1 instead of null, so the suites above never reach that branch. This
 * runs BetterAuth in a child process with the production environment to pin the
 * contract; if an upgrade skips limiting when no IP resolves, this fails.
 */
describe('BetterAuth contract: no resolvable client IP still rate-limits', () => {
	it('keys a request without the configured IP header into one shared bucket', () => {
		const script = `
			import { betterAuth } from 'better-auth';
			import { memoryAdapter } from 'better-auth/adapters/memory';
			const keys = [];
			const counts = new Map();
			const auth = betterAuth({
				baseURL: 'https://deployment.convex.site',
				secret: 'test-secret-with-enough-entropy-0123456789',
				database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
				emailAndPassword: { enabled: true },
				rateLimit: {
					enabled: true,
					customStorage: {
						get: async () => null,
						set: async () => {},
						consume: async (key, rule) => {
							keys.push(key);
							const count = (counts.get(key) ?? 0) + 1;
							counts.set(key, count);
							return count <= rule.max
								? { allowed: true, retryAfter: null }
								: { allowed: false, retryAfter: rule.window };
						},
					},
				},
				advanced: { ipAddress: { ipAddressHeaders: ['x-real-ip'] } },
				logger: { disabled: true },
			});
			const statuses = [];
			for (let attempt = 1; attempt <= 4; attempt += 1) {
				const response = await auth.handler(new Request('https://deployment.convex.site/api/auth/sign-in/email', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ email: 'nobody@example.com', password: 'not-the-password-1234' }),
				}));
				statuses.push(response.status);
			}
			process.stdout.write(JSON.stringify({ keys, statuses }));
		`;
		const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
		delete env['TEST'];
		delete env['VITEST'];
		const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
			cwd: process.cwd(),
			env,
			encoding: 'utf8',
		});
		const { keys, statuses } = JSON.parse(output) as { keys: string[]; statuses: number[] };

		expect(new Set(keys)).toEqual(new Set(['no-trusted-ip|/sign-in/email']));
		expect(statuses.slice(0, 3)).not.toContain(429);
		expect(statuses[3]).toBe(429);
	});
});
