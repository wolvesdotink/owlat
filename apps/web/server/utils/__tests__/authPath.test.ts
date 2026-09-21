import { describe, it, expect } from 'vitest';
import { authPathHasTraversal } from '../authPath';

/**
 * The auth proxy forwards `event.path` onto the Convex site URL. Without this
 * guard, `new URL()` would resolve a `..` out of the `/api/auth` namespace and
 * let a caller reach arbitrary Convex HTTP routes through the proxy.
 */
describe('authPathHasTraversal', () => {
	it('accepts legitimate BetterAuth paths', () => {
		for (const p of [
			'/api/auth/sign-in/email',
			'/api/auth/get-session',
			'/api/auth/callback/github?code=abc',
			'/api/auth/organization/list',
		]) {
			expect(authPathHasTraversal(p)).toBe(false);
		}
	});

	it('rejects a plain dot-dot traversal', () => {
		expect(authPathHasTraversal('/api/auth/../../secret')).toBe(true);
		expect(authPathHasTraversal('/api/auth/..')).toBe(true);
		expect(authPathHasTraversal('/api/auth/foo/../../bar')).toBe(true);
	});

	it('rejects a percent-encoded traversal', () => {
		expect(authPathHasTraversal('/api/auth/%2e%2e/admin')).toBe(true);
		expect(authPathHasTraversal('/api/auth/%2E%2E/admin')).toBe(true);
	});

	it('rejects a doubly-encoded traversal', () => {
		expect(authPathHasTraversal('/api/auth/%252e%252e/admin')).toBe(true);
	});

	it('rejects a backslash-separated traversal', () => {
		expect(authPathHasTraversal('/api/auth/..\\..\\admin')).toBe(true);
	});

	it('rejects malformed percent-encoding (fail closed)', () => {
		expect(authPathHasTraversal('/api/auth/%zz')).toBe(true);
	});

	it('does not flag a bare "dotdot" substring that is not a path segment', () => {
		expect(authPathHasTraversal('/api/auth/sign..in')).toBe(false);
		expect(authPathHasTraversal('/api/auth/file..txt')).toBe(false);
	});
});
