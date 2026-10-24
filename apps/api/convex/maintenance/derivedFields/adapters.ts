/**
 * The recompute adapters of every DERIVED field in the registry.
 *
 * Each recount reads the rows the field is a cache of and nothing else, within
 * the caller's budget, and reports the values as readers interpret them. The
 * arithmetic stays with the domain that owns the field wherever it already has
 * a home (the campaign shard sum, the outbound state derivation, the ledger's
 * money unit); an adapter only wires it to the parent row.
 *
 * Every recount runs in the same transaction as the repair it may lead to, so a
 * writer that commits between the two forces a retry instead of being
 * overwritten. That is why a parent too large to recount in one transaction is
 * skipped rather than counted across several.
 */

import type { Doc } from '../../_generated/dataModel';
import { AUDIT_LOG_RETENTION_MS } from '../../lib/constants';
import { nextUtcDayStart, utcMonthStart } from '../../lib/clock';
import { CAMPAIGN_SHARDED_STAT_FIELDS } from '../../lib/validators/campaigns';
import {
	isRolledUpOnSchedule,
	rollupCampaignStatsRow,
	summarizeCampaignStats,
} from '../../campaigns/statShards';
import { deriveAggregateState } from '../../mail/postboxOutboundLifecycle';
import { rebuildStart } from '../../aiRouting/spendAggregate';
import {
	ledgerRowBudgetClass,
	ledgerRowMicrousd,
	spendPeriodKeys,
} from '../../lib/aiRouting/spendPeriods';
import { derived, recountWithin, type DerivedFieldEntry, type RecountResult } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

const OVER_BUDGET: RecountResult = { status: 'skipped', reason: 'over_budget' };
const UNVERIFIABLE: RecountResult = { status: 'skipped', reason: 'unverifiable' };

const chatRoomActivity = derived({
	kind: 'derived',
	id: 'chatRoomActivity',
	table: 'chatRooms',
	fields: ['lastMessageAt', 'messageCount'],
	source:
		'chatMessages of the room, soft-deleted ones included: a delete keeps the row and the count',
	policy: 'exact',
	current: (room) => ({ messageCount: room.messageCount, lastMessageAt: room.lastMessageAt }),
	recompute: async (ctx, room, budget) => {
		let count = 0;
		let newest: number | undefined;
		const isComplete = await recountWithin(
			ctx.db.query('chatMessages').withIndex('by_room', (q) => q.eq('roomId', room._id)),
			budget,
			(message) => {
				count += 1;
				if (newest === undefined || message.createdAt > newest) newest = message.createdAt;
			}
		);
		if (!isComplete) return OVER_BUDGET;
		// An empty room's stamp is its creation time, which no message records.
		return {
			status: 'counted',
			expected: { messageCount: count, lastMessageAt: newest ?? room.lastMessageAt },
		};
	},
});

const assistantConversationMessages = derived({
	kind: 'derived',
	id: 'assistantConversationMessages',
	table: 'aiConversations',
	fields: ['messageCount'],
	source: 'aiMessages of the conversation (user turns and assistant turns)',
	policy: 'exact',
	current: (conversation) => ({ messageCount: conversation.messageCount }),
	recompute: async (ctx, conversation, budget) => {
		let count = 0;
		const isComplete = await recountWithin(
			ctx.db
				.query('aiMessages')
				.withIndex('by_conversation_and_created', (q) => q.eq('conversationId', conversation._id)),
			budget,
			() => {
				count += 1;
			}
		);
		if (!isComplete) return OVER_BUDGET;
		return { status: 'counted', expected: { messageCount: count } };
	},
});

const transactionalTemplateSends = derived({
	kind: 'derived',
	id: 'transactionalTemplateSends',
	table: 'transactionalEmails',
	fields: ['sendCount'],
	source: 'transactionalSends naming the template',
	// A lifetime total of enqueued sends: a Send row removed later (a reset, a
	// future retention rule) must not pull the count down, so the rows are a
	// lower bound and the cache is only ever raised to them.
	policy: 'raise_only',
	current: (template) => ({ sendCount: template.sendCount ?? 0 }),
	recompute: async (ctx, template, budget) => {
		let count = 0;
		const isComplete = await recountWithin(
			ctx.db
				.query('transactionalSends')
				.withIndex('by_transactional_email', (q) => q.eq('transactionalEmailId', template._id)),
			budget,
			() => {
				count += 1;
			}
		);
		if (!isComplete) return OVER_BUDGET;
		return { status: 'counted', expected: { sendCount: count } };
	},
});

const campaignSendStats = derived({
	kind: 'derived',
	id: 'campaignSendStats',
	table: 'campaigns',
	fields: CAMPAIGN_SHARDED_STAT_FIELDS,
	spread: 'campaignShardedStatFields',
	source: 'campaignStatShards of the campaign (summed by campaigns/statShards.ts)',
	policy: 'exact',
	isEligible: (campaign, now) =>
		campaign.deletedAt === undefined && !isRolledUpOnSchedule(campaign, now),
	current: (campaign) =>
		Object.fromEntries(CAMPAIGN_SHARDED_STAT_FIELDS.map((field) => [field, campaign[field] ?? 0])),
	recompute: async (ctx, campaign, budget) => {
		const sum = await summarizeCampaignStats(ctx.db, campaign._id);
		// At most STAT_SHARD_COUNT rows; charged as one so the budget still sees it.
		if (!budget.charge(sum)) return OVER_BUDGET;
		return { status: 'counted', expected: { ...sum } };
	},
	// The domain's own rollup: it rewrites every sharded field and the freshness stamp.
	repair: (ctx, campaign) => rollupCampaignStatsRow(ctx, campaign),
});

const pluginStorageQuota = derived({
	kind: 'derived',
	id: 'pluginStorageQuota',
	table: 'pluginStorageUsage',
	fields: ['entryCount', 'totalStoredBytes'],
	source: 'pluginStorageEntries of the organization and plugin',
	policy: 'exact',
	current: (usage) => ({ entryCount: usage.entryCount, totalStoredBytes: usage.totalStoredBytes }),
	recompute: async (ctx, usage, budget) => {
		let entryCount = 0;
		let totalStoredBytes = 0;
		const isComplete = await recountWithin(
			ctx.db
				.query('pluginStorageEntries')
				.withIndex('by_organization_id_and_plugin_id', (q) =>
					q.eq('organizationId', usage.organizationId).eq('pluginId', usage.pluginId)
				),
			budget,
			(entry) => {
				entryCount += 1;
				totalStoredBytes += entry.storedBytes;
			}
		);
		if (!isComplete) return OVER_BUDGET;
		return { status: 'counted', expected: { entryCount, totalStoredBytes } };
	},
	repair: async (ctx, usage, expected, now) => {
		// The storage service deletes the usage row with the last entry
		// (plugins/storage.ts); a recount of zero restores that invariant.
		if (expected['entryCount'] === 0) {
			await ctx.db.delete(usage._id);
			return;
		}
		await ctx.db.patch(usage._id, {
			entryCount: expected['entryCount'] as number,
			totalStoredBytes: expected['totalStoredBytes'] as number,
			updatedAt: now,
		});
	},
});

/**
 * Reservations and daily rows age out on the audit window, each in its own
 * batches (maintenance/retention.ts). A day whose row is a full day inside the
 * window still has every reservation it was charged for.
 */
function hasRetainedReservations(daily: Doc<'pluginLlmDailyUsage'>, now: number): boolean {
	return daily._creationTime >= now - AUDIT_LOG_RETENTION_MS + DAY_MS;
}

const pluginLlmDailySpend = derived({
	kind: 'derived',
	id: 'pluginLlmDailySpend',
	table: 'pluginLlmDailyUsage',
	fields: ['chargedMicrousd', 'actualMicrousd', 'admittedCallCount'],
	source:
		'pluginLlmReservations of the organization, plugin and UTC day: a pending or failed ' +
		'reservation holds its whole maximum, a completed one its settled charge',
	policy: 'exact',
	isEligible: hasRetainedReservations,
	current: (daily) => ({
		chargedMicrousd: daily.chargedMicrousd,
		actualMicrousd: daily.actualMicrousd,
		admittedCallCount: daily.admittedCallCount,
	}),
	recompute: async (ctx, daily, budget) => {
		let chargedMicrousd = 0;
		let actualMicrousd = 0;
		let admittedCallCount = 0;
		const isComplete = await recountWithin(
			ctx.db
				.query('pluginLlmReservations')
				.withIndex('by_organization_id_and_plugin_id_and_utc_day', (q) =>
					q
						.eq('organizationId', daily.organizationId)
						.eq('pluginId', daily.pluginId)
						.eq('utcDay', daily.utcDay)
				),
			budget,
			(reservation) => {
				// The same reading as plugins/llmAccounting.ts settlementResult.
				chargedMicrousd += reservation.chargedMicrousd ?? reservation.reservedMicrousd;
				actualMicrousd += reservation.actualMicrousd ?? 0;
				admittedCallCount += 1;
			}
		);
		if (!isComplete) return OVER_BUDGET;
		return { status: 'counted', expected: { chargedMicrousd, actualMicrousd, admittedCallCount } };
	},
	repair: async (ctx, daily, expected, now) => {
		await ctx.db.patch(daily._id, {
			chargedMicrousd: expected['chargedMicrousd'] as number,
			actualMicrousd: expected['actualMicrousd'] as number,
			admittedCallCount: expected['admittedCallCount'] as number,
			updatedAt: now,
		});
	},
});

/**
 * Ledger rows are bucketed by their `createdAt`, which the insert stamps in the
 * same mutation that assigns `_creationTime`; the range read is widened by this
 * much on both sides so a row near a period edge is still seen.
 */
const LEDGER_RANGE_SLACK_MS = 60 * 1000;

/** The UTC instants a spend bucket key covers, or null for a malformed key. */
export function spendPeriodRange(
	periodKind: 'day' | 'month',
	periodKey: string
): { start: number; end: number } | null {
	const start = Date.parse(`${periodKind === 'day' ? periodKey : `${periodKey}-01`}T00:00:00Z`);
	if (!Number.isFinite(start)) return null;
	const end = periodKind === 'day' ? nextUtcDayStart(start) : utcMonthStart(start + 32 * DAY_MS);
	return { start, end };
}

const llmSpendBuckets = derived({
	kind: 'derived',
	id: 'llmSpendBuckets',
	table: 'llmSpendPeriods',
	fields: ['settledMicrousd', 'estimatedMicrousd', 'eventCount'],
	source: 'llmUsageEvents of the period, plane and budget class',
	policy: 'exact',
	current: (bucket) => ({
		settledMicrousd: bucket.settledMicrousd,
		estimatedMicrousd: bucket.estimatedMicrousd,
		eventCount: bucket.eventCount,
	}),
	recompute: async (ctx, bucket, budget) => {
		// Only a bucket of the current generation, after a finished rebuild, and
		// inside the periods that rebuild recounted, holds every row of its
		// period (aiRouting/spendAggregate.ts). Readers treat an older
		// generation as zero, and older periods may predate the aggregate.
		const state = await ctx.db.query('llmSpendAggregateState').first();
		if (!state || state.status !== 'complete' || bucket.generation !== state.generation) {
			return UNVERIFIABLE;
		}
		const range = spendPeriodRange(bucket.periodKind, bucket.periodKey);
		if (!range || range.start < rebuildStart(state)) return UNVERIFIABLE;

		let settledMicrousd = 0;
		let estimatedMicrousd = 0;
		let eventCount = 0;
		const isComplete = await recountWithin(
			ctx.db
				.query('llmUsageEvents')
				.withIndex('by_creation_time', (q) =>
					q
						.gte('_creationTime', range.start - LEDGER_RANGE_SLACK_MS)
						.lt('_creationTime', range.end + LEDGER_RANGE_SLACK_MS)
				),
			budget,
			(row) => {
				const keys = spendPeriodKeys(row.createdAt);
				if ((bucket.periodKind === 'day' ? keys.day : keys.month) !== bucket.periodKey) return;
				if ((row.plane ?? 'language') !== bucket.plane) return;
				if (ledgerRowBudgetClass(row) !== bucket.budgetClass) return;
				const microusd = ledgerRowMicrousd(row);
				settledMicrousd += microusd;
				if (row.isEstimated === true) estimatedMicrousd += microusd;
				eventCount += 1;
			}
		);
		if (!isComplete) return OVER_BUDGET;
		return { status: 'counted', expected: { settledMicrousd, estimatedMicrousd, eventCount } };
	},
	repair: async (ctx, bucket, expected, now) => {
		await ctx.db.patch(bucket._id, {
			settledMicrousd: expected['settledMicrousd'] as number,
			estimatedMicrousd: expected['estimatedMicrousd'] as number,
			eventCount: expected['eventCount'] as number,
			updatedAt: now,
		});
	},
});

const postboxOutboundState = derived({
	kind: 'derived',
	id: 'postboxOutboundState',
	table: 'mailMessages',
	fields: ['outbound.state'],
	source: 'outbound.recipients[] of the same row (mail/postboxOutboundLifecycle.ts)',
	policy: 'exact',
	isEligible: (message) => message.outbound !== undefined,
	current: (message) => ({ 'outbound.state': message.outbound?.state }),
	recompute: async (_ctx, message, budget) => {
		const recipients = message.outbound?.recipients;
		if (!recipients) return UNVERIFIABLE;
		if (!budget.charge(recipients)) return OVER_BUDGET;
		return {
			status: 'counted',
			expected: { 'outbound.state': deriveAggregateState(recipients) },
		};
	},
	repair: async (ctx, message) => {
		if (!message.outbound) return;
		await ctx.db.patch(message._id, {
			outbound: {
				...message.outbound,
				state: deriveAggregateState(message.outbound.recipients),
			},
		});
	},
});

export const DERIVED_FIELD_ENTRIES: readonly DerivedFieldEntry[] = [
	chatRoomActivity,
	assistantConversationMessages,
	transactionalTemplateSends,
	campaignSendStats,
	pluginStorageQuota,
	pluginLlmDailySpend,
	llmSpendBuckets,
	postboxOutboundState,
];
