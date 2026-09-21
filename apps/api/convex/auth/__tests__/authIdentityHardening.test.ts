import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ActionCtx } from '../../_generated/server';
import { createAuthOptions } from '../auth';
import { resolveBetterAuthIpAddressConfig } from '../ipAddress';
import { resolveTrustedOrigins } from '../trustedOrigins';
import { assertRegistrationAllowed } from '../registrationGate';

/**
 * Auth identity hardening (P3):
 *   - M12: the BetterAuth login limiter keys on the RIGHT-anchored trusted
 *     client IP (via `advanced.ipAddress`), aligned with the public limiter's
 *     RATE_LIMIT_TRUSTED_PROXY switch, instead of the spoofable leftmost XFF.
 *   - L10: `trustedOrigins` drops the silent loopback fallback in production and
 *     requires SITE_URL.
 *   - H3: email verification (signup + invitation) is enabled together and only
 *     when REQUIRE_EMAIL_VERIFICATION opts in, so existing installs aren't locked
 *     out.
 *
 * ctx is never touched (option shape only), matching authOptionsSecret.test.ts.
 */
const ctx = {} as ActionCtx;

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('resolveBetterAuthIpAddressConfig (M12)', () => {
	it('fails closed to an empty header list (limiter stays ON) when no trusted proxy is declared', () => {
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', '');
		// Empty header list ⇒ BetterAuth resolves no client IP and keys the shared
		// `no-trusted-ip` bucket, so sign-in/reset are STILL throttled. It must NOT
		// return `disableIpTracking`, which would turn the login limiter off.
		const config = resolveBetterAuthIpAddressConfig();
		expect(config).toEqual({ ipAddressHeaders: [] });
		expect(config.disableIpTracking).toBeUndefined();
	});

	it('trusts CF-Connecting-IP in cloudflare mode', () => {
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', 'cloudflare');
		expect(resolveBetterAuthIpAddressConfig()).toEqual({
			ipAddressHeaders: ['cf-connecting-ip'],
		});
	});

	it('trusts X-Real-IP in xrealip mode', () => {
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', 'xrealip');
		expect(resolveBetterAuthIpAddressConfig()).toEqual({ ipAddressHeaders: ['x-real-ip'] });
	});

	it('right-anchors XFF with parsed trusted proxies in xforwarded mode', () => {
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', 'xforwarded');
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXIES', '10.0.0.0/8, 192.0.2.10');
		expect(resolveBetterAuthIpAddressConfig()).toEqual({
			ipAddressHeaders: ['x-forwarded-for'],
			trustedProxies: ['10.0.0.0/8', '192.0.2.10'],
		});
	});

	it('omits trustedProxies (single-value only, fail closed on multi-hop) when unset', () => {
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', 'xforwarded:2');
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXIES', '');
		expect(resolveBetterAuthIpAddressConfig()).toEqual({ ipAddressHeaders: ['x-forwarded-for'] });
	});

	it('never keys the spoofable leftmost XFF (unrecognised mode fails closed, limiter stays ON)', () => {
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', 'leftmost');
		const config = resolveBetterAuthIpAddressConfig();
		expect(config).toEqual({ ipAddressHeaders: [] });
		expect(config.disableIpTracking).toBeUndefined();
	});

	it('is wired into the auth options advanced.ipAddress', () => {
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', 'cloudflare');
		expect(createAuthOptions(ctx).advanced?.ipAddress).toEqual({
			ipAddressHeaders: ['cf-connecting-ip'],
		});
	});

	it('an un-proxied production deployment still rate-limits sign-in (limiter enabled, tracking not disabled)', () => {
		vi.stubEnv('OWLAT_DEV_MODE', '');
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', '');
		const options = createAuthOptions(ctx);
		// The limiter is enabled outside dev...
		expect(options.rateLimit?.enabled).toBe(true);
		// ...and the un-proxied default does NOT disable IP tracking (which would
		// switch the login/reset limiter off entirely in better-auth 1.6.25).
		expect(options.advanced?.ipAddress).toEqual({ ipAddressHeaders: [] });
		expect(options.advanced?.ipAddress?.disableIpTracking).toBeUndefined();
	});
});

describe('resolveTrustedOrigins (L10)', () => {
	it('keeps loopback fallbacks in dev', () => {
		vi.stubEnv('OWLAT_DEV_MODE', 'true');
		vi.stubEnv('SITE_URL', '');
		vi.stubEnv('ADMIN_SITE_URL', '');
		expect(resolveTrustedOrigins()).toEqual([
			'http://localhost:3000',
			'http://localhost:3001',
			'tauri://localhost',
			'https://tauri.localhost',
		]);
	});

	it('requires SITE_URL in production (no silent loopback trust)', () => {
		vi.stubEnv('OWLAT_DEV_MODE', '');
		vi.stubEnv('SITE_URL', '');
		expect(() => resolveTrustedOrigins()).toThrow(/SITE_URL/);
	});

	it('trusts SITE_URL and only sets ADMIN_SITE_URL when present in production', () => {
		vi.stubEnv('OWLAT_DEV_MODE', '');
		vi.stubEnv('SITE_URL', 'https://app.example.com');
		vi.stubEnv('ADMIN_SITE_URL', '');
		expect(resolveTrustedOrigins()).toEqual([
			'https://app.example.com',
			'tauri://localhost',
			'https://tauri.localhost',
		]);

		vi.stubEnv('ADMIN_SITE_URL', 'https://admin.example.com');
		expect(resolveTrustedOrigins()).toEqual([
			'https://app.example.com',
			'https://admin.example.com',
			'tauri://localhost',
			'https://tauri.localhost',
		]);
	});
});

describe('server-side registration gate (H3)', () => {
	type FindManyResult = { page: unknown[] };
	// Build a ctx whose runQuery answers the two model lookups the gate performs.
	function ctxWith(users: unknown[], invitations: unknown[]): ActionCtx {
		const runQuery = vi.fn(
			async (_ref: unknown, args: { model: string }): Promise<FindManyResult> => {
				if (args.model === 'user') return { page: users };
				if (args.model === 'invitation') return { page: invitations };
				return { page: [] };
			}
		);
		return { runQuery } as unknown as ActionCtx;
	}

	const liveInvite = (email: string) => ({
		email,
		status: 'pending',
		expiresAt: Date.now() + 60_000,
	});
	const expiredInvite = (email: string) => ({
		email,
		status: 'pending',
		expiresAt: Date.now() - 60_000,
	});

	it('allows the very first account when no user exists yet (signup bootstrap)', async () => {
		await expect(
			assertRegistrationAllowed(ctxWith([], []), 'owner@example.com')
		).resolves.toBeUndefined();
	});

	it('rejects a missing/blank email (fails closed)', async () => {
		await expect(assertRegistrationAllowed(ctxWith([{}], []), '')).rejects.toThrow(/email/i);
		await expect(assertRegistrationAllowed(ctxWith([{}], []), undefined)).rejects.toThrow(/email/i);
	});

	it('rejects an un-invited signup once the instance is bootstrapped', async () => {
		await expect(
			assertRegistrationAllowed(ctxWith([{ email: 'owner@example.com' }], []), 'intruder@evil.com')
		).rejects.toThrow(/invite-only/i);
	});

	it('rejects when only an EXPIRED pending invitation matches', async () => {
		await expect(
			assertRegistrationAllowed(
				ctxWith([{ email: 'owner@example.com' }], [expiredInvite('invitee@example.com')]),
				'invitee@example.com'
			)
		).rejects.toThrow(/invite-only/i);
	});

	it('allows a signup that matches a live pending invitation (email normalized)', async () => {
		await expect(
			assertRegistrationAllowed(
				ctxWith([{ email: 'owner@example.com' }], [liveInvite('invitee@example.com')]),
				'  Invitee@Example.com  '
			)
		).resolves.toBeUndefined();
	});
});

describe('email verification enablement (H3)', () => {
	it('is off by default (unset) so existing installs are not locked out', () => {
		vi.stubEnv('REQUIRE_EMAIL_VERIFICATION', '');
		const options = createAuthOptions(ctx);
		expect(options.emailAndPassword?.requireEmailVerification).toBe(false);
		expect(options.emailVerification?.sendOnSignUp).toBe(false);
	});

	it('enables signup verification when REQUIRE_EMAIL_VERIFICATION opts in', () => {
		vi.stubEnv('REQUIRE_EMAIL_VERIFICATION', 'true');
		const options = createAuthOptions(ctx);
		expect(options.emailAndPassword?.requireEmailVerification).toBe(true);
		expect(options.emailVerification?.sendOnSignUp).toBe(true);
	});
});
