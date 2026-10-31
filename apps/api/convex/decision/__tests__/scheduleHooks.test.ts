/**
 * The pipeline hooks (`decision/schedule.ts`): nothing is scheduled while a
 * switch is off (the default), each hook schedules exactly its own action when
 * on (a Team hook through the bundle the step's commit schedules), and a
 * failure never escapes into the pipeline. The admission seam itself
 * is covered through the real admission in `bundleAdmissionWiring.test.ts`.
 */

import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';
import { resolveRoutingPolicy, type ResolvedRoutingPolicy } from '@owlat/shared/aiRouting';
import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import {
	schedulePostboxMessageBundle,
	scheduleTeamBundle,
	teamMessageBundle,
	teamTriageBundle,
	type TeamBundle,
} from '../schedule';

const inboundMessageId = 'm1' as Id<'inboundMessages'>;
const threadId = 't1' as Id<'mailThreads'>;

function fakeCtx(
	policy: ResolvedRoutingPolicy,
	opts: { scheduleThrows?: boolean; isAllowed?: boolean; queryThrows?: boolean } = {}
) {
	const scheduled: { name: string; args: unknown }[] = [];
	const ctx = {
		runQuery: vi.fn(async () => {
			if (opts.queryThrows) throw new Error('gate unreadable');
			return { policy, isAllowed: opts.isAllowed ?? true };
		}),
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

/** The Team hooks, each bundle scheduled as the step's commit would. */
async function teamHooks(
	ctx: ActionCtx,
	policy: ResolvedRoutingPolicy,
	today: Parameters<typeof teamMessageBundle>[1]
): Promise<void> {
	const bundles = [await teamTriageBundle(ctx, policy), await teamMessageBundle(ctx, today)];
	for (const bundle of bundles.filter((b): b is TeamBundle => b !== null)) {
		await scheduleTeamBundle(ctx, inboundMessageId, bundle);
	}
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
		await teamHooks(ctx, DEFAULTS, { baseline: { category: 'support' } });
		await schedulePostboxMessageBundle(ctx, {
			threadId,
			expectedLatestMessageId: undefined,
			baseline: { category: 'other' },
		});
		expect(scheduled).toEqual([]);
	});

	it('schedule exactly their own action when on', async () => {
		const { ctx, scheduled } = fakeCtx(ON);
		await teamHooks(ctx, ON, {
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
		await teamHooks(ctx, ON, { baseline: { category: 'support' } });
		await schedulePostboxMessageBundle(ctx, {
			threadId,
			expectedLatestMessageId: undefined,
			baseline: { category: 'other' },
		});
		expect(scheduled).toEqual([]);
	});

	it('never let a scheduling failure escape into the pipeline', async () => {
		// A Team bundle's scheduling failure is swallowed by the step's commit
		// (agent/stepWrites.ts, best-effort); an unreadable gate schedules none.
		const { ctx } = fakeCtx(ON, { queryThrows: true });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await expect(teamTriageBundle(ctx, ON)).resolves.toBeNull();
		await expect(teamMessageBundle(ctx, { baseline: {} })).resolves.toBeNull();
		const failing = fakeCtx(ON, { scheduleThrows: true });
		await expect(
			schedulePostboxMessageBundle(failing.ctx, {
				threadId,
				expectedLatestMessageId: undefined,
				baseline: {},
			})
		).resolves.toBeUndefined();
		warn.mockRestore();
	});
});
