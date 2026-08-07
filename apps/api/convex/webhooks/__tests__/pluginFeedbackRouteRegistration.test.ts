/**
 * The plugin feedback route is actually MOUNTED (the seams plan's D6/P2.2).
 *
 * `pluginFeedbackRoute.test.ts` drives the handler directly, which is what makes
 * the adversarial cases readable — but a handler nothing routes to is a webhook
 * that answers Convex's own 404 to every provider, and no amount of handler
 * testing would notice. So this suite walks the REAL router in `http.ts`.
 *
 * The observable is deliberately the BODY, not the status. An unrouted path also
 * answers 404, so a status assertion would pass just as happily with the route
 * deleted; the JSON envelope below can only have been produced by our handler.
 *
 * With the shipped (empty) composition every plugin id is unknown, which is the
 * honest end state today: `plugins.config.ts` bundles nothing, so the route's
 * correct answer to the whole world is "no such webhook". That is exactly the
 * property worth pinning at the boundary — the surface exists, it is reachable,
 * and it admits nobody.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { describe, expect, it } from 'vitest';
import schema from '../../schema';
import { PLUGIN_FEEDBACK_PATH_PREFIX } from '../pluginFeedbackHttp';

// Vite's `import.meta.glob` excludes the directory chain it climbed to reach the
// glob base, so `'../../**'` from this `webhooks/__tests__` file omits the
// sibling `webhooks/*` modules. Merge a second glob rooted at `webhooks/` and
// re-prefix its keys (the idiom `adapterRegistry.test.ts` documents).
const rootGlob = import.meta.glob('../../**/*.*s');
const webhooksGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../webhooks/'),
		mod,
	])
);
const modules = { ...rootGlob, ...webhooksGlob };

function setupTest() {
	const t = convexTest(schema, modules);
	// The route spends a rate-limit token before it decides anything, so every
	// request here reaches the rate-limiter component.
	rateLimiterTest.register(t);
	return t;
}

describe('POST /webhooks/plugin/<pluginId>', () => {
	it('is routed to the plugin feedback handler', async () => {
		const response = await setupTest().fetch(`${PLUGIN_FEEDBACK_PATH_PREFIX}mail-pack`, {
			method: 'POST',
			body: '{}',
			headers: { 'Content-Type': 'application/json' },
		});

		expect(response.status).toBe(404);
		// Our envelope, which an unrouted path cannot produce.
		expect(await response.json()).toEqual({ error: 'Unknown plugin webhook' });
	});

	it('is registered for POST only', async () => {
		// The router resolves a prefix PER METHOD, so a GET reaches no handler of
		// ours at all — the plugin surface deliberately has no unsigned probe route
		// (Mandrill's URL-validation GET is a CORE kind's ceremony, and giving every
		// plugin id an unauthenticated 200 would confirm which plugins are bundled).
		// The handler's own 405 arm stays as defense in depth for a future method
		// registration; it is exercised in `pluginFeedbackRoute.test.ts`.
		const response = await setupTest().fetch(`${PLUGIN_FEEDBACK_PATH_PREFIX}mail-pack`, {
			method: 'GET',
		});

		expect(response.status).toBe(404);
		expect(await response.text()).not.toContain('Unknown plugin webhook');
	});

	it('does not shadow the core kinds’ static feedback routes', async () => {
		// `/webhooks/plugin/…` is a prefix route living beside `/webhooks/ses` and
		// friends. Those URLs are pasted into provider consoles we do not own, so a
		// prefix that swallowed them would be a silent, total feedback outage.
		const response = await setupTest().fetch('/webhooks/resend', {
			method: 'POST',
			body: '{}',
			headers: { 'Content-Type': 'application/json' },
		});

		expect(response.status).not.toBe(404);
		expect(await response.json()).not.toEqual({ error: 'Unknown plugin webhook' });
	});
});
