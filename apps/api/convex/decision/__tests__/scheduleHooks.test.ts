/**
 * The pipeline hooks (`decision/schedule.ts`): nothing is scheduled while a
 * switch is off (the default), each hook schedules exactly its own action when
 * on, and a failure never escapes into the pipeline. The admission seam itself
 * is covered through the real admission in `bundleAdmissionWiring.test.ts`.
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

const inboundMessageId = 'm1' as Id<'inboundMessages'>;
const threadId = 't1' as Id<'mailThreads'>;

function fakeCtx(
	policy: ResolvedRoutingPolicy,
	opts: { scheduleThrows?: boolean; isAllowed?: boolean } = {}
) {
	const scheduled: { name: string; args: unknown }[] = [];
	const ctx = {
		runQuery: vi.fn(async () => ({ policy, isAllowed: opts.isAllowed ?? true })),
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

	it('schedule nothing for a mailbox excluded from hosted decisions', async () => {
		const { ctx, scheduled } = fakeCtx(ON, { isAllowed: false });
		await scheduleTeamTriage(ctx, ON, inboundMessageId);
		await scheduleTeamMessageBundle(ctx, inboundMessageId, { baseline: { category: 'support' } });
		await schedulePostboxMessageBundle(ctx, {
			threadId,
			expectedLatestMessageId: undefined,
			baseline: { category: 'other' },
		});
		expect(scheduled).toEqual([]);
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
