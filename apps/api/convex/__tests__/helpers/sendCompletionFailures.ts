import type { TestConvex } from 'convex-test';
import type { WorkId } from '@convex-dev/workpool';
import type schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { createTestCampaign, createTestContact, createTestEmailSend } from '../factories';

/**
 * Shared fixtures for the send-completion-failure suites (#1195). Each suite
 * mocks the lifecycle's effect runner itself (`vi.mock` is per file).
 */

export type T = TestConvex<typeof schema>;
export const DAY = 24 * 60 * 60 * 1000;

export function acceptedCompletion(
	sendId: Id<'emailSends'>,
	providerMessageId: string,
	options: { workId?: string; isCustodyHandoff?: boolean; providerType?: string } = {}
) {
	return {
		workId: (options.workId ?? `work-${sendId}`) as WorkId,
		result: {
			kind: 'success' as const,
			returnValue: {
				kind: 'accepted',
				providerMessageId,
				providerType: options.providerType ?? 'ses',
				sendLatencyMs: 12,
				isCustodyHandoff: options.isCustodyHandoff ?? false,
			},
		},
		context: { sendRef: { kind: 'campaign' as const, id: sendId } },
	};
}

/** A deferral past the delivery deadline: the arm terminalizes, so a fault throws. */
export function expiredDeferral(
	sendId: Id<'emailSends'>,
	contactId: Id<'contacts'>,
	email: string,
	workId = `defer-${sendId}`
) {
	return {
		workId: workId as WorkId,
		context: { sendRef: { kind: 'campaign' as const, id: sendId } },
		result: {
			kind: 'success' as const,
			returnValue: {
				kind: 'deferred',
				deferralOrigin: 'local',
				retryAfterMs: 60_000,
				envelopeInput: {
					kind: 'campaign',
					to: email,
					from: 'sender@example.com',
					template: { subject: 'Private details', htmlContent: '<p>Private details</p>' },
					contactInfo: { contactId, email, firstName: 'Private name' },
					emailSendId: sendId,
				},
				retryState: {
					attempt: 1,
					startedAt: Date.now() - 5 * DAY,
					idempotencyKey: `send_${sendId}`,
				},
			},
		},
	};
}

export async function setupQueuedSend(
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
				...overrides,
			})
		);
		return { campaignId, sendId };
	});
}

export async function failureRows(t: T) {
	return await t.run(async (ctx) => await ctx.db.query('sendCompletionFailures').collect());
}

/** Resolved history for one Send, the shape earlier failures leave behind. */
export async function insertResolvedRecords(
	t: T,
	sendId: Id<'emailSends'>,
	count: number
): Promise<void> {
	const now = Date.now();
	await t.run(async (ctx) => {
		const send = await ctx.db.get(sendId);
		for (let i = 0; i < count; i++) {
			await ctx.db.insert('sendCompletionFailures', {
				sendRef: { kind: 'campaign', id: sendId },
				contactId: send?.contactId,
				workId: `resolved-${i}`,
				status: 'resolved',
				resolution: 'replayed',
				outcomeKind: 'deferred',
				lastError: 'UNKNOWN',
				replayAttempts: 0,
				firstFailedAt: now,
				lastFailedAt: now,
				resolvedAt: now,
			});
		}
	});
}

export async function statsSent(t: T, campaignId: Id<'campaigns'>): Promise<number> {
	return await t.run(async (ctx) => {
		const shards = await ctx.db
			.query('campaignStatShards')
			.withIndex('by_campaign_and_shard', (q) => q.eq('campaignId', campaignId))
			.collect();
		return shards.reduce((sum, shard) => sum + (shard.statsSent ?? 0), 0);
	});
}
