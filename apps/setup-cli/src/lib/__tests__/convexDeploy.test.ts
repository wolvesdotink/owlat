import { describe, it, expect } from 'vitest';
import {
	parseAdminKey,
	looksLikeRealAdminKey,
	selectRuntimeEnvVars,
	CONVEX_RUNTIME_ENV_KEYS,
} from '../convexDeploy';
import { ensureSecrets } from '../secrets';

describe('parseAdminKey', () => {
	it('extracts a prefixed self-hosted key (keeps the | separator)', () => {
		const out = 'Admin key:\nconvex-self-hosted|01ab23cd45ef67890123456789abcdef\n';
		expect(parseAdminKey(out)).toBe('convex-self-hosted|01ab23cd45ef67890123456789abcdef');
	});

	it('extracts a bare long token', () => {
		expect(parseAdminKey('  0123456789abcdef0123456789abcdef  ')).toBe(
			'0123456789abcdef0123456789abcdef',
		);
	});

	it('takes the LAST key-shaped token when several are printed', () => {
		const out = 'noise short\nfirstkey_0123456789abcdef0\nconvex-self-hosted|finalkey0123456789abcdef';
		expect(parseAdminKey(out)).toBe('convex-self-hosted|finalkey0123456789abcdef');
	});

	it('returns null when there is no key-shaped token', () => {
		expect(parseAdminKey('error: backend not ready')).toBeNull();
		expect(parseAdminKey('')).toBeNull();
	});
});

describe('looksLikeRealAdminKey', () => {
	it('accepts a backend-issued key with a | separator', () => {
		expect(looksLikeRealAdminKey('convex-self-hosted|01ab23cd45ef67890123456789ab')).toBe(true);
	});

	it('rejects a fabricated random string (no separator)', () => {
		// A 48-char alnum string like the OLD ensureSecrets() produced.
		expect(looksLikeRealAdminKey('aB3kZ9qWeRtYuIoPaSdFgHjKlZxCvBnMqWeRtYuIoPaSdFgH')).toBe(false);
	});

	it('rejects undefined / short values', () => {
		expect(looksLikeRealAdminKey(undefined)).toBe(false);
		expect(looksLikeRealAdminKey('a|b')).toBe(false);
	});
});

describe('selectRuntimeEnvVars', () => {
	it('selects only function-runtime keys with non-empty values', () => {
		const env = {
			BETTER_AUTH_SECRET: 'secret',
			EMAIL_PROVIDER: 'mta',
			OWLAT_DEV_MODE: 'true',
			// compose-only — must NOT be pushed to the Convex runtime:
			NUXT_PUBLIC_CONVEX_URL: 'http://localhost:3210',
			REDIS_PASSWORD: 'pw',
			CONVEX_ADMIN_KEY: 'convex-self-hosted|x',
			CONVEX_PORT: '3210',
			// present-but-empty must be skipped:
			RESEND_API_KEY: '',
		};
		const out = Object.fromEntries(selectRuntimeEnvVars(env));
		expect(out).toEqual({
			BETTER_AUTH_SECRET: 'secret',
			EMAIL_PROVIDER: 'mta',
			OWLAT_DEV_MODE: 'true',
		});
		expect(out['NUXT_PUBLIC_CONVEX_URL']).toBeUndefined();
		expect(out['REDIS_PASSWORD']).toBeUndefined();
		expect(out['CONVEX_ADMIN_KEY']).toBeUndefined();
		expect(out['RESEND_API_KEY']).toBeUndefined();
	});

	it('CONVEX_ADMIN_KEY / NUXT_PUBLIC_* / REDIS_* are not runtime keys', () => {
		expect(CONVEX_RUNTIME_ENV_KEYS).not.toContain('CONVEX_ADMIN_KEY');
		expect(CONVEX_RUNTIME_ENV_KEYS).not.toContain('NUXT_PUBLIC_CONVEX_URL');
		expect(CONVEX_RUNTIME_ENV_KEYS).not.toContain('REDIS_PASSWORD');
		// but the auth secret and dev-mode flag are:
		expect(CONVEX_RUNTIME_ENV_KEYS).toContain('BETTER_AUTH_SECRET');
		expect(CONVEX_RUNTIME_ENV_KEYS).toContain('OWLAT_DEV_MODE');
	});

	it('pushes the GitHub-webhook secret and LLM complexity-routing flag (regression: these had drifted out of the list)', () => {
		expect(CONVEX_RUNTIME_ENV_KEYS).toContain('GITHUB_WEBHOOK_SECRET');
		expect(CONVEX_RUNTIME_ENV_KEYS).toContain('LLM_COMPLEXITY_ROUTING');
	});
});

describe('ensureSecrets no longer fabricates the Convex admin key', () => {
	it('generates auth/instance/mta secrets but NOT CONVEX_ADMIN_KEY', () => {
		const out = ensureSecrets({});
		expect(out['BETTER_AUTH_SECRET']).toBeTruthy();
		expect(out['INSTANCE_SECRET']).toBeTruthy();
		// INSTANCE_SECRET MUST be hex — the self-hosted Convex backend
		// hex-decodes it on boot and crashes on a non-hex value.
		expect(out['INSTANCE_SECRET']).toMatch(/^[0-9a-f]{64}$/);
		expect(out['UNSUBSCRIBE_SECRET']).toBeTruthy();
		expect(out['MTA_API_KEY']).toMatch(/^mta_/);
		expect(out['MTA_WEBHOOK_SECRET']).toMatch(/^whsec_/);
		// The admin key must be minted by the backend, not fabricated:
		expect(out['CONVEX_ADMIN_KEY']).toBeUndefined();
	});

	it('preserves an existing real admin key', () => {
		const out = ensureSecrets({ CONVEX_ADMIN_KEY: 'convex-self-hosted|abc' });
		expect(out['CONVEX_ADMIN_KEY']).toBe('convex-self-hosted|abc');
	});
});
