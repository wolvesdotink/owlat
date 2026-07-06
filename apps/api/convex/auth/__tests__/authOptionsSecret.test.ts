import { describe, it, expect, afterEach, vi } from 'vitest';
import { getAuthTables } from 'better-auth/db';
import type { ActionCtx } from '../../_generated/server';
import { createAuthOptions } from '../auth';

/**
 * Regression: the betterAuth component (convex/betterAuth/adapter.ts) calls
 * `createAuthOptions({})` at import time purely to derive its table schema via
 * `getAuthTables`. Convex components cannot read deployment environment
 * variables, so an EAGER `getRequired('BETTER_AUTH_SECRET')` inside
 * createAuthOptions throws during module analysis and fails every push with
 * "Missing required environment variable: BETTER_AUTH_SECRET" — even when the
 * variable IS set on the deployment (app modules see it, the component does
 * not).
 *
 * The secret is therefore exposed as a lazy getter: building the options (and
 * deriving the schema) must work without the env var, while actually READING
 * the secret keeps the fail-closed throw so a misconfigured deploy can never
 * fall back to BetterAuth's publicly-known default signing key.
 *
 * The ctx is never touched here (schema derivation reads only static option
 * shape), so a bare cast is sufficient — same contract as changeEmail.test.ts.
 */
const ctx = {} as ActionCtx;

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('createAuthOptions secret handling', () => {
	it('builds options and derives auth tables without BETTER_AUTH_SECRET (component import path)', () => {
		// getRequired treats empty as unset; vitest.setup.ts seeds a test secret,
		// so blank it out to reproduce the component analysis environment.
		vi.stubEnv('BETTER_AUTH_SECRET', '');

		// Mirrors convex/betterAuth/adapter.ts: createApi runs this at import time.
		const tables = getAuthTables(createAuthOptions(ctx));

		expect(Object.keys(tables).length).toBeGreaterThan(0);
	});

	it('fails closed when the secret is read while unset', () => {
		vi.stubEnv('BETTER_AUTH_SECRET', '');

		const options = createAuthOptions(ctx);

		expect(() => options.secret).toThrow(
			'Missing required environment variable: BETTER_AUTH_SECRET'
		);
	});

	it('returns the configured secret when set', () => {
		vi.stubEnv('BETTER_AUTH_SECRET', 'configured-secret');

		expect(createAuthOptions(ctx).secret).toBe('configured-secret');
	});
});
