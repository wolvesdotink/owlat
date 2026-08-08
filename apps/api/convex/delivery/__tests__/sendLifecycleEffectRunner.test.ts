/**
 * THE EFFECT RUNNER'S UNKNOWN-KIND ARM.
 *
 * `applyEffects` is exhaustive over `Effect` at COMPILE time — deleting a case
 * stops the build rather than quietly never applying that effect. Nothing in the
 * type system covers the other direction: an effect whose kind THIS build has no
 * case for, arriving from a job the previous deploy scheduled or a shape read
 * back out of a payload.
 *
 * The arm has to drop that one effect and keep walking. Returning out of the
 * loop instead — which is what an exhaustiveness `return exhaustive` does at
 * runtime — silently drops every effect AFTER it: the blocklist insert, the
 * campaign counters, the webhook fanout. That is strictly worse than the single
 * silent no-op the compile-time check was added to prevent.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { modules } from '../../__tests__/testModules';
import { createTestContact } from '../../__tests__/factories';
import type { Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { applyEffects, type Effect } from '../sendLifecycle/effects';

/**
 * A kind no version of `Effect` in this build declares, carrying a payload
 * field as a real skewed effect would. Cast because the whole point is that the
 * type system cannot express what arrives at runtime.
 */
const UNKNOWN_EFFECT = {
	kind: 'transport_outcome_v2',
	sendId: 'send_from_the_other_deploy',
} as unknown as Effect;

async function seedContacts(t: ReturnType<typeof convexTest>): Promise<Id<'contacts'>[]> {
	return await t.run(async (ctx) => [
		await ctx.db.insert('contacts', createTestContact({ softBounceCount: 0 })),
		await ctx.db.insert('contacts', createTestContact({ softBounceCount: 0 })),
	]);
}

describe('an effect kind this build cannot read', () => {
	it('does not stop the effects queued behind it', async () => {
		const t = convexTest(schema, modules);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const [before, after] = await seedContacts(t);

		await t.run(async (ctx) => {
			await applyEffects(ctx as MutationCtx, [
				{ kind: 'contact_soft_bounce_count', contactId: before!, count: 3 },
				UNKNOWN_EFFECT,
				{ kind: 'contact_soft_bounce_count', contactId: after!, count: 5 },
			]);
		});

		await t.run(async (ctx) => {
			expect((await ctx.db.get(before!))?.softBounceCount).toBe(3);
			// THE REGRESSION. This one is queued AFTER the unreadable effect, and an
			// early return would leave it unapplied with nothing thrown.
			expect((await ctx.db.get(after!))?.softBounceCount).toBe(5);
		});

		warn.mockRestore();
	});

	it('warns with the tag and nothing else off the effect', async () => {
		const t = convexTest(schema, modules);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		await t.run(async (ctx) => {
			await applyEffects(ctx as MutationCtx, [UNKNOWN_EFFECT]);
		});

		expect(warn).toHaveBeenCalledTimes(1);
		const logged = warn.mock.calls.map((call) => call.join(' ')).join(' ');
		// Named, so a systematic skew is visible rather than inferred from a gap in
		// the counters...
		expect(logged).toContain('transport_outcome_v2');
		// ...but only the tag: an effect this build cannot name may be carrying a
		// recipient address, and a warning is not a PII sink.
		expect(logged).not.toContain('send_from_the_other_deploy');

		warn.mockRestore();
	});
});
