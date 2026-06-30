/**
 * Unit tests for the setup-mode middleware allowlist (`setup.global.ts`).
 *
 * The middleware redirects every route to `/setup` while the runtime `setupMode`
 * flag is live. The flag only clears on a web-container restart, so an operator
 * who just finished the wizard would be bounced back to `/setup` on the way to
 * sign in — unless `/auth/*` (and the wizard/asset paths) are allowlisted. We
 * test `isSetupAllowlisted` directly rather than the Nuxt middleware wrapper.
 *
 * The middleware module calls `defineNuxtRouteMiddleware` at import time, so we
 * stub that Nuxt auto-import to an identity before importing the file.
 */

import { describe, it, expect, vi } from 'vitest';

vi.stubGlobal('defineNuxtRouteMiddleware', (fn: unknown) => fn);
vi.stubGlobal('navigateTo', vi.fn());

const { isSetupAllowlisted, SETUP_ALLOWLIST_PREFIXES } = await import('../setup.global');

describe('setup-mode middleware — allowlist', () => {
	it('lets the auth/sign-in routes through so the operator can sign in post-apply', () => {
		// The bounce trap: the web process keeps setupMode=true until it restarts,
		// so without this the just-finished wizard would redirect /auth/login back
		// to /setup forever.
		expect(isSetupAllowlisted('/auth/login')).toBe(true);
		expect(isSetupAllowlisted('/auth/login?postSetup=1')).toBe(true);
		expect(isSetupAllowlisted('/auth/forgot-password')).toBe(true);
	});

	it('lets the wizard, its API, and its static assets through', () => {
		expect(isSetupAllowlisted('/setup')).toBe(true);
		expect(isSetupAllowlisted('/setup/admin')).toBe(true);
		expect(isSetupAllowlisted('/api/setup/apply')).toBe(true);
		expect(isSetupAllowlisted('/_nuxt/entry.js')).toBe(true);
		expect(isSetupAllowlisted('/favicon.ico')).toBe(true);
	});

	it('redirects every other route to the wizard (not allowlisted)', () => {
		expect(isSetupAllowlisted('/')).toBe(false);
		expect(isSetupAllowlisted('/dashboard')).toBe(false);
		expect(isSetupAllowlisted('/dashboard/campaigns')).toBe(false);
		expect(isSetupAllowlisted('/pricing')).toBe(false);
	});

	it('exposes /auth as an allowlisted prefix', () => {
		expect(SETUP_ALLOWLIST_PREFIXES).toContain('/auth');
	});
});
