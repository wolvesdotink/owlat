import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { MutationCtx } from '../../_generated/server';
import { trackEvent } from '../posthogHelpers';

/**
 * `analytics.posthog` decides whether this instance talks to PostHog at all.
 * It is off by default, and on a self-hosted deployment that default is the
 * promise the docs make — so both halves of the backend path are pinned here:
 * the mutation-side helper must not even schedule the send, and the action must
 * refuse to send when it runs (an admin can turn the flag off between the two).
 */

const captureMock = vi.fn();
const shutdownMock = vi.fn(async () => {});

vi.mock('posthog-node', () => ({
	PostHog: class {
		capture = captureMock;
		shutdown = shutdownMock;
	},
}));

vi.mock('../env', async () => {
	const actual = await vi.importActual<typeof import('../env')>('../env');
	return {
		...actual,
		getOptional: (key: string) => (key === 'POSTHOG_API_KEY' ? 'phc_test' : undefined),
	};
});

// Vite canonicalizes glob keys for files in this same subtree ('../posthog'
// rather than '../../lib/posthog'), while convex-test derives its lookup prefix
// from '../../_generated/...'. Re-prefix the canonicalized half so
// `internal.lib.posthog.capture` resolves.
const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).map(([key, value]) =>
		key.startsWith('../') && !key.startsWith('../../')
			? (['../../lib/' + key.slice(3), value] as const)
			: ([key, value] as const)
	)
);

async function enableAnalytics(t: ReturnType<typeof convexTest>) {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			featureFlags: { 'analytics.posthog': true },
			createdAt: Date.now(),
		});
	});
}

describe('backend PostHog capture — analytics.posthog gate', () => {
	beforeEach(() => {
		captureMock.mockClear();
		shutdownMock.mockClear();
	});

	it('sends nothing when the flag is off, even with POSTHOG_API_KEY set', async () => {
		const t = convexTest(schema, modules);

		await t.action(internal.lib.posthog.capture, {
			distinctId: 'user_1',
			event: 'contact_created',
		});

		expect(captureMock).not.toHaveBeenCalled();
	});

	it('sends the event when the flag is on', async () => {
		const t = convexTest(schema, modules);
		await enableAnalytics(t);

		await t.action(internal.lib.posthog.capture, {
			distinctId: 'user_1',
			event: 'contact_created',
		});

		expect(captureMock).toHaveBeenCalledTimes(1);
		expect(captureMock.mock.calls[0]?.[0]).toMatchObject({
			distinctId: 'user_1',
			event: 'contact_created',
		});
	});

	it('trackEvent does not even schedule the action while the flag is off', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			const runAfter = vi.fn();
			const spied = { ...ctx, scheduler: { ...ctx.scheduler, runAfter } };
			await trackEvent(spied as unknown as MutationCtx, { userId: 'user_1' }, 'contact_created');
			expect(runAfter).not.toHaveBeenCalled();
		});
	});

	it('trackEvent schedules the action once the flag is on', async () => {
		const t = convexTest(schema, modules);
		await enableAnalytics(t);

		await t.run(async (ctx) => {
			const runAfter = vi.fn();
			const spied = { ...ctx, scheduler: { ...ctx.scheduler, runAfter } };
			await trackEvent(spied as unknown as MutationCtx, { userId: 'user_1' }, 'contact_created');
			expect(runAfter).toHaveBeenCalledTimes(1);
		});
	});
});
