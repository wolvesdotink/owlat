/**
 * Fixtures for the read-on-arrival contract: one realistic row in every
 * arrival table, all pointing at one message, so the contract, purge,
 * retention and erasure tests seed the same shapes.
 */

import type { Doc, Id } from '../../../_generated/dataModel';
import type { MutationCtx } from '../../../_generated/server';
import { arrivalChangeRow } from '../changeRows';

export interface ArrivalSeedRefs {
	mailboxId: Id<'mailboxes'>;
	threadId: Id<'mailThreads'>;
	messageId: Id<'mailMessages'>;
	folderId: Id<'mailFolders'>;
}

export interface ArrivalSeedIds {
	recordId: Id<'mailArrivalRecords'>;
	profileId: Id<'mailSenderProfiles'>;
	operationId: Id<'mailArrivalOperations'>;
	changeIds: Id<'mailArrivalOperationChanges'>[];
	ruleDraftId: Id<'mailRuleDrafts'>;
	delayedActionId: Id<'mailDelayedActions'>;
	digestId: Id<'mailDigests'>;
	filterId: Id<'mailFilters'>;
	labelId: Id<'mailLabels'>;
}

/** Insert one row per arrival table (and a filter and label they name). */
export async function seedArrivalRows(
	ctx: MutationCtx,
	refs: ArrivalSeedRefs,
	opts: { now?: number; expiresAt?: number; digestState?: Doc<'mailDigests'>['state'] } = {}
): Promise<ArrivalSeedIds> {
	const now = opts.now ?? Date.now();
	const expiresAt = opts.expiresAt ?? now + 30 * 24 * 60 * 60 * 1000;
	const { mailboxId, threadId, messageId, folderId } = refs;
	const filterId = await ctx.db.insert('mailFilters', {
		mailboxId,
		name: 'Newsletters to digest',
		isEnabled: true,
		priority: 100,
		conditions: [{ field: 'from', op: 'contains', value: 'news' }],
		actions: [{ type: 'sendToDigest' }, { type: 'archiveAfter', hours: 24 }],
		stopProcessing: false,
		sourceText: 'sealed:newsletters go to my digest',
		aiCondition: { question: 'Is this a newsletter?', revision: 1 },
		origin: 'plain_language',
		revision: 1,
		createdAt: now,
		updatedAt: now,
	});
	const labelId = await ctx.db.insert('mailLabels', { mailboxId, name: 'News', createdAt: now });
	const operationId = await ctx.db.insert('mailArrivalOperations', {
		mailboxId,
		kind: 'rule_apply',
		actor: 'rule',
		threadId,
		messageId,
		filterId,
		reason: 'sealed:reason',
		changeCount: 3,
		status: 'applied',
		createdAt: now,
		expiresAt,
	});
	const recordId = await ctx.db.insert('mailArrivalRecords', {
		mailboxId,
		threadId,
		messageId,
		sourceKey: `mail:${messageId}`,
		sourceOrderKey: 'k1',
		depth: 'count',
		category: 'newsletter',
		categorySource: 'heuristic',
		filterMatches: [{ filterId, revision: 1, pass: 'ai', answer: true }],
		pendingAiFilters: [{ filterId, revision: 1, question: 'Is this a newsletter?' }],
		rulePlacement: 'digest',
		exclusiveWinners: { placement: { source: 'hook', filterId, priority: 100 } },
		lastOperationId: operationId,
		modelCalls: 0,
		reasonKeys: [{ key: 'arrival.reason.budget', params: { limit: 120 } }],
		degradedBy: 'budget',
		createdAt: now,
		updatedAt: now,
		expiresAt,
	});
	const profileId = await ctx.db.insert('mailSenderProfiles', {
		mailboxId,
		senderDigest: 'digest-news',
		address: 'news@example.com',
		status: 'digest',
		statusSource: 'learned',
		statusOperationId: operationId,
		placementOverride: 'today',
		placementOverrideOperationId: operationId,
		kind: 'newsletter',
		weekAnchor: now,
		deliveredWeeks: Array.from({ length: 13 }, () => 0),
		openedWeeks: Array.from({ length: 13 }, () => 0),
		unsubscribe: { method: 'one_click', requestedAt: now, result: 'confirmed' },
		unusedDraftStreak: 0,
		unreadArchiveEvidence: { count: 5, sessions: 3, lastSessionKey: 'k', version: 1 },
		lastOperationId: operationId,
		createdAt: now,
		updatedAt: now,
	});
	const changes = [
		arrivalChangeRow({
			operationId,
			mailboxId,
			change: { kind: 'messageFolder', messageId, before: folderId, after: folderId },
			isNeedsReplyCleared: true,
			now,
		}),
		arrivalChangeRow({
			operationId,
			mailboxId,
			change: { kind: 'messageLabel', messageId, labelId, before: false, after: true },
			now,
		}),
		arrivalChangeRow({
			operationId,
			mailboxId,
			change: {
				kind: 'threadPlacementOverride',
				threadId,
				before: null,
				after: { placement: 'digest', setAt: now, operationId },
			},
			now,
		}),
	];
	const changeIds: Id<'mailArrivalOperationChanges'>[] = [];
	for (const change of changes) {
		changeIds.push(await ctx.db.insert('mailArrivalOperationChanges', { ...change, expiresAt }));
	}
	const ruleDraftId = await ctx.db.insert('mailRuleDrafts', {
		mailboxId,
		sourceText: 'sealed:newsletters go to my digest',
		status: 'ready',
		preview: {
			name: 'Newsletters',
			conditions: [{ field: 'from', op: 'contains', value: 'news' }],
			aiCondition: { question: 'Is this a newsletter?', revision: 1 },
			actions: [{ type: 'sendToDigest' }],
		},
		origin: 'fix',
		fromMessageId: messageId,
		createdAt: now,
		expiresAt,
	});
	const delayedActionId = await ctx.db.insert('mailDelayedActions', {
		mailboxId,
		threadId,
		messageId,
		actionKey: `${messageId}:archive:rule`,
		action: 'archive',
		runAt: now + 60_000,
		source: 'rule',
		filterId,
		createdByOperationId: operationId,
		anchor: { messageReceivedAt: now, messageSourceOrderKey: 'k1', folderId },
		state: 'pending',
		createdAt: now,
		updatedAt: now,
	});
	const digestId = await ctx.db.insert('mailDigests', {
		mailboxId,
		periodKey: '2026-10-17',
		state: opts.digestState ?? 'generated',
		claimToken: 'token',
		claimUntil: now + 60_000,
		generationAttempts: 1,
		items: [{ threadId, messageId, kind: 'newsletter', spans: [{ quote: 'sealed:quote' }] }],
		visited: [{ threadId, throughSourceOrderKey: 'k1', kind: 'newsletter' }],
		overflowByKind: { newsletter: 2, updates: 0, promotion: 0 },
		overflowLabel: 'exact',
		createdAt: now,
		expiresAt,
	});
	return {
		recordId,
		profileId,
		operationId,
		changeIds,
		ruleDraftId,
		delayedActionId,
		digestId,
		filterId,
		labelId,
	};
}
