/**
 * Recorded send completions stay inside Convex's transaction read limit (#1195).
 *
 * A deferral's outcome carries its rendered message, so a record's payload can
 * approach the 1 MiB document limit. Every path that lists records (the replay
 * cron, retention, operator re-open and status, workspace deletion) reads only
 * the small record rows; payloads live in their own table and are read one
 * record at a time. These tests run with convex-test's real transaction limits
 * and a backlog of 25 payloads of 700 KiB, which is 17.5 MiB together.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { beginWorkspaceDeletion, readDeletionProgress } from '../workspaces/deletion/job';
import {
	DAY,
	expiredDeferral,
	failureRows,
	payloadRows,
	setupQueuedSend,
	type T,
} from './helpers/sendCompletionFailures';

const modules = import.meta.glob('../**/*.*s');
const BACKLOG = 25;
const PAYLOAD_BYTES = 700 * 1024;

function harness(): T {
	return convexTest({ schema, modules, transactionLimits: true }) as T;
}

/** `BACKLOG` records of one queued Send, each with a 700 KiB deferral payload. */
async function heavyBacklog(t: T, status: 'open' | 'exhausted'): Promise<Id<'emailSends'>> {
	const { sendId } = await setupQueuedSend(t);
	const send = (await t.run((ctx) => ctx.db.get(sendId)))!;
	const { result } = expiredDeferral(sendId, send.contactId, send.contactEmail);
	result.returnValue.envelopeInput.template.htmlContent = 'x'.repeat(PAYLOAD_BYTES);
	const now = Date.now();
	for (let i = 0; i < BACKLOG; i++) {
		await t.run(async (ctx) => {
			const failureId = await ctx.db.insert('sendCompletionFailures', {
				sendRef: { kind: 'campaign', id: sendId },
				contactId: send.contactId,
				workId: `heavy-${i}`,
				status,
				outcomeKind: 'deferred',
				lastError: 'CONVEX_VALIDATION',
				replayAttempts: status === 'open' ? 0 : 10,
				firstFailedAt: now - 92 * DAY,
				lastFailedAt: now - 91 * DAY,
				...(status === 'open' ? { nextReplayAt: now - 1 } : {}),
			});
			await ctx.db.insert('sendCompletionFailurePayloads', { failureId, result });
		});
	}
	return sendId;
}

describe('a backlog of large recorded outcomes', () => {
	it('lets the replay cron and the status query run to completion', async () => {
		const t = harness();
		const sendId = await heavyBacklog(t, 'open');

		const status = await t.query(internal.delivery.sendCompletionFailureAdmin.status, {});
		expect(status).toMatchObject({ open: BACKLOG, exhausted: 0 });

		expect(
			await t.mutation(internal.delivery.sendCompletionFailures.replayDueCompletionFailures, {})
		).toEqual({ scheduled: BACKLOG });
		await t.finishAllScheduledFunctions(() => {});

		// The first replay ends the Send past its deadline; the rest find it settled.
		expect((await t.run((ctx) => ctx.db.get(sendId)))?.status).toBe('failed');
		expect((await failureRows(t)).every((row) => row.status === 'resolved')).toBe(true);
		expect(await payloadRows(t)).toHaveLength(0);
	});

	it('lets operator re-open and the retention purge run to completion', async () => {
		const t = harness();
		await heavyBacklog(t, 'exhausted');

		expect(
			await t.mutation(
				internal.delivery.sendCompletionFailureAdmin.reopenExhaustedCompletionFailures,
				{}
			)
		).toEqual({ reopened: BACKLOG });
		await t.run(async (ctx) => {
			for (const row of await ctx.db.query('sendCompletionFailures').collect()) {
				await ctx.db.patch(row._id, { status: 'exhausted', nextReplayAt: undefined });
			}
		});

		await t.mutation(internal.delivery.sendCompletionFailureAdmin.purgeCompletionFailures, {});
		await t.finishAllScheduledFunctions(() => {});
		expect(await failureRows(t)).toHaveLength(0);
		expect(await payloadRows(t)).toHaveLength(0);
	});

	it('lets a workspace deletion sweep both tables', async () => {
		const t = harness();
		await heavyBacklog(t, 'exhausted');
		const { jobId } = await t.run((ctx) =>
			beginWorkspaceDeletion(ctx, { source: 'previous_release' }, 'sendCompletionFailurePayloads')
		);
		await t.run(async (ctx) => {
			const progress = (await readDeletionProgress(ctx.db, jobId))!;
			await ctx.db.patch(progress._id, { phase: 'sweep' });
		});

		const ownSteps = new Set(['sendCompletionFailurePayloads', 'sendCompletionFailures']);
		for (let tick = 0; tick < 20; tick++) {
			const step = (await t.run((ctx) => readDeletionProgress(ctx.db, jobId)))?.step;
			if (!step || !ownSteps.has(step)) break;
			await t.mutation(internal.workspaces.deletion.walker.tick, { jobId });
		}
		expect(await payloadRows(t)).toHaveLength(0);
		expect(await failureRows(t)).toHaveLength(0);
	});
});
