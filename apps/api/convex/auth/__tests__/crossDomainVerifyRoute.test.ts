import { describe, it, expect } from 'vitest';
import type { ActionCtx } from '../../_generated/server';
import { createAuthOptions } from '../auth';

/**
 * Regression: the desktop "connect an existing server" handshake redeems its
 * one-time token against `/cross-domain/one-time-token/verify`, an endpoint the
 * `crossDomain` plugin exports under the key `verifyOneTimeToken`. The
 * `oneTimeToken` plugin exports a DIFFERENT path under the SAME key, and
 * BetterAuth merges plugin endpoints by key with later plugins winning. When
 * `oneTimeToken` was listed after `crossDomain`, the cross-domain route vanished
 * from the router and every desktop connect ended in an empty 404.
 *
 * The ctx is never touched (only the static plugin list is read), so a bare
 * cast is sufficient — same contract as authOptionsSecret.test.ts.
 */
const ctx = {} as ActionCtx;

type PluginWithEndpoints = {
	id: string;
	endpoints?: Record<string, { path?: string }>;
};

/** Mirror BetterAuth's merge: last plugin defining a key wins. */
function mergedEndpointPaths(plugins: PluginWithEndpoints[]): Record<string, string | undefined> {
	const merged: Record<string, string | undefined> = {};
	for (const plugin of plugins) {
		for (const [key, endpoint] of Object.entries(plugin.endpoints ?? {})) {
			merged[key] = endpoint.path;
		}
	}
	return merged;
}

describe('auth plugin order: cross-domain one-time-token verify', () => {
	const plugins = (createAuthOptions(ctx).plugins ?? []) as PluginWithEndpoints[];

	it('registers both plugins that fight over the verifyOneTimeToken key', () => {
		const ids = plugins.map((p) => p.id);
		expect(ids).toContain('one-time-token');
		expect(ids).toContain('cross-domain');
	});

	it('keeps the cross-domain verify route the desktop app redeems against', () => {
		const paths = mergedEndpointPaths(plugins);
		expect(paths['verifyOneTimeToken']).toBe('/cross-domain/one-time-token/verify');
		// The browser-side /desktop/connect page still needs the generate route.
		expect(paths['generateOneTimeToken']).toBe('/one-time-token/generate');
	});
});
