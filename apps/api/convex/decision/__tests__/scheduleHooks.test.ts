/**
 * The pipeline hooks (`decision/schedule.ts`): nothing is scheduled while a
 * switch is off (the default), each hook schedules exactly its own action when
 * on, and a failure never escapes into the pipeline. Plus the admission seam's
 * posture until the admission lane is merged: it admits nothing.
 */

import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';
import { resolveRoutingPolicy, type ResolvedRoutingPolicy } from '@owlat/shared/aiRouting';
import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import {
	schedulePostboxMessageBundle,
	scheduleTeamMessageBundle,
	scheduleTeamTriage,
} from '../schedule';
import { admitBundle } from '../bundleAdmission';

const inboundMessageId = 'm1' as Id<'inboundMessages'>;
const threadId = 't1' as Id<'mailThreads'>;

function fakeCtx(policy: ResolvedRoutingPolicy, opts: { scheduleThrows?: boolean } = {}) {
	const scheduled: { name: string; args: unknown }[] = [];
	const ctx = {
		runQuery: vi.fn(async () => policy),
		scheduler: {
			runAfter: vi.fn(async (_delay: number, reference: unknown, args: unknown) => {
				if (opts.scheduleThrows) throw new Error('scheduler down');
				scheduled.push({
					name: getFunctionName(reference as Parameters<typeof getFunctionName>[0]),
					args,
				});
			}),
		},
	};
	return { ctx: ctx as unknown as ActionCtx, scheduled };
}

const DEFAULTS = resolveRoutingPolicy(null);
const ON = resolveRoutingPolicy({
	policyVersion: 1,
	triageBundle: 'shadow',
	categoryDisplayBundle: 'shadow',
	shadowCapUsd: 1,
});

describe('pipeline hooks', () => {
	it('schedule nothing with every switch off', async () => {
		const { ctx, scheduled } = fakeCtx(DEFAULTS);
		await scheduleTeamTriage(ctx, DEFAULTS, inboundMessageId);
		await scheduleTeamMessageBundle(ctx, inboundMessageId, { baseline: { category: 'support' } });
		await schedulePostboxMessageBundle(ctx, {
			threadId,
			expectedLatestMessageId: undefined,
			baseline: { category: 'other' },
		});
		expect(scheduled).toEqual([]);
	});

	it('schedule exactly their own action when on', async () => {
		const { ctx, scheduled } = fakeCtx(ON);
		await scheduleTeamTriage(ctx, ON, inboundMessageId);
		await scheduleTeamMessageBundle(ctx, inboundMessageId, {
			baseline: { category: 'support', disposition: 'reply' },
			language: 'de',
		});
		await schedulePostboxMessageBundle(ctx, {
			threadId,
			expectedLatestMessageId: undefined,
			baseline: { category: 'other' },
		});
		expect(scheduled).toEqual([
			{ name: 'decision/bundleActions:teamTriage', args: { inboundMessageId } },
			{
				name: 'decision/bundleActions:teamMessage',
				args: {
					inboundMessageId,
					baseline: { category: 'support', disposition: 'reply' },
					language: 'de',
				},
			},
			{
				name: 'decision/bundleActions:postboxMessage',
				args: { threadId, baseline: { category: 'other' } },
			},
		]);
	});

	it('never let a scheduling failure escape into the pipeline', async () => {
		const { ctx } = fakeCtx(ON, { scheduleThrows: true });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await expect(scheduleTeamTriage(ctx, ON, inboundMessageId)).resolves.toBeUndefined();
		await expect(
			scheduleTeamMessageBundle(ctx, inboundMessageId, { baseline: {} })
		).resolves.toBeUndefined();
		warn.mockRestore();
	});
});

describe('the admission seam before the admission lane is merged', () => {
	it('admits nothing, so no paid bundle call can run unreserved', async () => {
		await expect(
			admitBundle({} as ActionCtx, {
				task: 'mail.triage',
				mode: 'shadow',
				subjectKey: inboundMessageId,
				feature: 'decision_triage',
				root: { rootRequestId: `team:${inboundMessageId}` },
				policyVersion: 1,
			})
		).resolves.toEqual({ isAdmitted: false, why: 'admission_unavailable' });
	});
});
