import { vi } from 'vitest';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { createTestCampaign, createTestContact, createTestEmailSend } from '../factories';
import type { T } from './sendCompletionFailures';

/** Shared fixtures for the lost-send sweep suites (#1208). */

export const HOUR = 60 * 60 * 1000;
export const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);

export function at(ms: number): void {
	vi.setSystemTime(ms);
}

export async function queuedCampaignSend(
	t: T,
	overrides: Record<string, unknown> = {}
): Promise<{ campaignId: Id<'campaigns'>; sendId: Id<'emailSends'> }> {
	return await t.run(async (ctx) => {
		const campaignId = await ctx.db.insert('campaigns', createTestCampaign({ status: 'sending' }));
		const contactId = await ctx.db.insert('contacts', createTestContact());
		const sendId = await ctx.db.insert(
			'emailSends',
			createTestEmailSend({
				campaignId,
				contactId,
				status: 'queued',
				providerMessageId: undefined,
				queuedAt: Date.now(),
				...overrides,
			})
		);
		return { campaignId, sendId };
	});
}

export async function queuedTransactionalSend(t: T): Promise<Id<'transactionalSends'>> {
	return await t.run(
		async (ctx) =>
			await ctx.db.insert('transactionalSends', {
				kind: 'transactional',
				email: 'person@example.com',
				status: 'queued',
				queuedAt: Date.now(),
			})
	);
}

export async function getSend(t: T, sendId: Id<'emailSends'> | Id<'transactionalSends'>) {
	return await t.run(async (ctx) => await ctx.db.get(sendId));
}

/** Run the cron and every page it schedules. */
export async function runCron(t: T): Promise<void> {
	await t.mutation(internal.delivery.stuckSendSweep.sweepLostSends, {});
	await drainSweep(t);
}

export async function drainSweep(t: T): Promise<void> {
	await t.finishAllScheduledFunctions(vi.runAllTimers);
}

export async function holdLease(t: T, pass: string, generation: number, heartbeatAt: number) {
	await t.run(async (ctx) => {
		await ctx.db.insert('lostSendSweepLeases', {
			pass,
			generation,
			isActive: true,
			cutoff: 0,
			startedAt: heartbeatAt,
			heartbeatAt,
		});
	});
}

export async function pendingPages(t: T) {
	return await t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect()).filter(
			(job) => job.state.kind === 'pending' && job.name.endsWith('sweepLostSendPage')
		)
	);
}
