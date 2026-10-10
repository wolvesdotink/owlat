/**
 * Final review r2, F1: while an erasure of a Team Inbox thread is still
 * running (budgeted slices), the thread reads partial and the D3 hold refuses
 * auto-send, in the route gate and in the transaction that creates an
 * autonomous Send. Once the last slice ran, the purge no longer holds.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import { unitBudget } from '../purgeDrain';
import { drivePurgeJob } from '../purgeRun';
import { interpretationHoldFor } from '../teamActions';
import { loadBriefRow } from '../briefRow';
import { modules, seedTeamThread } from './interpret.testlib';
import { SENT, insertItem } from './purge.testlib';

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('D3 holds during an unfinished erasure', () => {
	it('refuses auto-send mid-purge and stops holding for the purge once it finished', async () => {
		const t = convexTest(schema, modules);
		const { threadId, inboundId } = await seedTeamThread(t);
		const ref = { kind: 'team' as const, id: threadId };
		const erased = await t.run(async (ctx) => {
			const id = await ctx.db.insert('inboundMessages', {
				messageId: '<earlier@example.com>',
				from: 'customer@example.com',
				to: 'support@owlat.test',
				subject: 'Order 42',
				textBody: 'Earlier',
				processingStatus: 'sent',
				receivedAt: SENT - 60_000,
				threadId,
			});
			// Many claims of the erased message: one slice cannot redact them all.
			for (let i = 0; i < 5; i++) {
				await insertItem(ctx, ref, [
					{ kind: 'inbound', id },
					{ kind: 'inbound', id: inboundId },
				]);
			}
			return id;
		});
		const fields = {
			ref,
			kind: 'sources' as const,
			sources: [{ kind: 'inbound' as const, id: erased }],
		};

		const isDone = await t.run((ctx) => drivePurgeJob(ctx, 'hold', fields, unitBudget(1)));
		expect(isDone).toBe(false);
		const mid = await t.run(async (ctx) => ({
			reason: await interpretationHoldFor(ctx, inboundId),
			brief: await loadBriefRow(ctx, ref),
		}));
		expect(mid.reason).toContain('purge_in_progress');
		expect(mid.brief).toMatchObject({ activePurgeJobs: 1, completeness: 'partial' });
		const routed = await t.query(internal.mail.interpret.teamActions.interpretationHold, {
			inboundMessageId: inboundId,
		});
		expect(routed.reason).toContain('purge_in_progress');

		for (let slice = 0; slice < 100; slice++) {
			if (await t.run((ctx) => drivePurgeJob(ctx, 'hold', fields, unitBudget(50)))) break;
		}
		const after = await t.run(async (ctx) => ({
			reason: await interpretationHoldFor(ctx, inboundId),
			brief: await loadBriefRow(ctx, ref),
		}));
		expect(after.brief?.activePurgeJobs).toBe(0);
		// Still held, but for what the purge left (redacted items to review), not the purge.
		expect(after.reason ?? '').not.toContain('purge_in_progress');
	});
});
