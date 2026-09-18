/**
 * decision.gate.assertDecisionAllowed — the gate every decision-plane call runs
 * before it spends anything.
 *
 * Three properties, in the order an operator cares about them: the kill switch
 * stops third-party decision traffic outright, the instance-global bucket caps
 * it when it is on, and the error shape is the one `mail/ai/gate.ts` throws so
 * a caller's existing fail-soft catch behaves identically on either plane.
 */
import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { ConvexError } from 'convex/values';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';

// Vite's `import.meta.glob` excludes the directory chain it climbed up through
// to reach the glob base, so `'../../**'` from this `decision/__tests__` file
// omits the sibling `decision/*` modules under test. Merge a second glob rooted
// at `decision/` and re-prefix its keys to the same `../../`-relative form.
const rootGlob = import.meta.glob('../../**/*.*s');
const decisionGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../decision/'),
		mod,
	])
);
const modules = { ...rootGlob, ...decisionGlob };

async function setup(featureFlags?: Record<string, boolean>) {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	if (featureFlags) {
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
	}
	return t;
}

/** The `{ category, message }` payload every Operation error carries. */
function categoryOf(error: unknown): string | undefined {
	return error instanceof ConvexError
		? (error.data as { category?: string } | undefined)?.category
		: undefined;
}

describe('decision.gate.assertDecisionAllowed', () => {
	it('blocks an install that never opted in — no settings row at all', async () => {
		const t = await setup();
		await expect(t.mutation(internal.decision.gate.assertDecisionAllowed, {})).rejects.toThrow(
			/decision plane is disabled/i
		);
	});

	it('blocks while the decision-plane flag is off, even with AI on', async () => {
		const t = await setup({ ai: true, 'ai.decisionPlane': false });
		await expect(t.mutation(internal.decision.gate.assertDecisionAllowed, {})).rejects.toThrow(
			/decision plane is disabled/i
		);
	});

	it('blocks when the master AI toggle is off, whatever the decision flag says', async () => {
		// The dependency is what makes the AI kill switch a decision-plane kill
		// switch too: an operator pulling the master toggle must not leave traffic
		// going to a third party.
		const t = await setup({ ai: false, 'ai.decisionPlane': true });
		await expect(t.mutation(internal.decision.gate.assertDecisionAllowed, {})).rejects.toThrow(
			/decision plane is disabled/i
		);
	});

	it('throws the mail/ai gate error shape — a `forbidden` Operation error', async () => {
		const t = await setup({ ai: true });
		const error = await t
			.mutation(internal.decision.gate.assertDecisionAllowed, {})
			.then(() => undefined)
			.catch((e: unknown) => e);
		expect(categoryOf(error)).toBe('forbidden');
	});

	it('allows the call once both flags are on, and reports the breaker as closed', async () => {
		const t = await setup({ ai: true, 'ai.decisionPlane': true });
		await expect(t.mutation(internal.decision.gate.assertDecisionAllowed, {})).resolves.toEqual({
			// `allowed` is the token `runDecision` requires: the gate is the only
			// thing that builds one, so the kill switch cannot be routed around.
			allowed: true,
			fallbackAllowed: true,
			breakerState: 'closed',
		});
	});

	it('rate-limits once the instance-global bucket drains', async () => {
		const t = await setup({ ai: true, 'ai.decisionPlane': true });

		let allowed = 0;
		let error: unknown;
		for (let i = 0; i < 400; i++) {
			try {
				await t.mutation(internal.decision.gate.assertDecisionAllowed, {});
				allowed += 1;
			} catch (e) {
				error = e;
				break;
			}
		}
		expect(error).toBeDefined();
		expect(categoryOf(error)).toBe('rate_limited');
		// Capacity is 240; the bucket refills while the loop runs, so the exact
		// count is not pinned — only that the cap is real and roomy.
		expect(allowed).toBeGreaterThanOrEqual(240);
		expect(allowed).toBeLessThan(400);
	});

	it('reports a tripped breaker back to the caller instead of blocking the decision', async () => {
		const t = await setup({ ai: true, 'ai.decisionPlane': true });
		// Burn the failure budget: 20 failures is an outage, not a blip.
		for (let i = 0; i < 20; i++) {
			await t.mutation(internal.decision.breaker.recordFailure, {});
		}

		// The cheap decision call still goes through — the breaker only forbids
		// the expensive hop onto the language model.
		await expect(t.mutation(internal.decision.gate.assertDecisionAllowed, {})).resolves.toEqual({
			allowed: true,
			fallbackAllowed: false,
			breakerState: 'open',
		});
	});
});
