/**
 * The read-on-arrival contract: every new table and field
 * validates a realistic row, every index the later lanes build on exists with
 * the fields they query by, the shared vocabularies match the validators, the
 * new filter actions are no-ops on the existing paths, and no hook is still
 * a stub (the final wiring gate).
 */

import { convexTest } from 'convex-test';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Infer } from 'convex/values';
import type {
	ArrivalOperationChange,
	MailCategory,
	Placement,
	SenderStatus,
} from '@owlat/shared/arrival';
import { ARRIVAL_FILTER_ACTION_TYPES } from '@owlat/shared/arrival';
import schema from '../schema';
import type { Doc, Id } from '../_generated/dataModel';
import { modules, seedFolder, seedMailbox, seedMessage } from '../mail/__tests__/helpers.testlib';
import { seedArrivalRows } from '../mail/arrival/__tests__/arrival.testlib';
import { mailCategoryLabelValidator } from '../lib/literalValidators';
import type {
	ArrivalOperationChangeRow,
	placementValidator,
	senderStatusValidator,
} from '../lib/validators/arrival';
import { MAIL_ARRIVAL_TABLES, mailArrivalTables } from '../schema/mailArrival';
import { arrivalChangeRow } from '../mail/arrival/changeRows';
import { evaluateFilters } from '../mail/filters';
import { resolveFilterOutcome } from '../mail/deliveryPipeline/routing';
import { hasRetroactiveActions } from '../mail/filterRun';
import { ARRIVAL_HOOK_OWNERS, ARRIVAL_HOOK_STUBS } from '../mail/arrival/hooks';

type TableName = keyof typeof schema.tables;

function indexesOf(table: TableName): Record<string, string[]> {
	return Object.fromEntries(
		schema.tables[table][' indexes']().map((index) => [index.indexDescriptor, index.fields])
	);
}

/** The indexes later lanes query by: [table, index, fields]. */
const EXPECTED_INDEXES: [TableName, string, string[]][] = [
	['mailArrivalRecords', 'by_message', ['messageId']],
	['mailArrivalRecords', 'by_thread_created', ['threadId', 'createdAt']],
	['mailArrivalRecords', 'by_thread_source_order', ['threadId', 'sourceOrderKey']],
	['mailArrivalRecords', 'by_mailbox', ['mailboxId']],
	['mailArrivalRecords', 'by_expires', ['expiresAt']],
	['mailSenderProfiles', 'by_mailbox_sender', ['mailboxId', 'senderDigest']],
	['mailSenderProfiles', 'by_mailbox_status_last', ['mailboxId', 'status', 'lastDeliveredAt']],
	['mailSenderProfiles', 'by_mailbox_last', ['mailboxId', 'lastDeliveredAt']],
	['mailArrivalOperations', 'by_mailbox_created', ['mailboxId', 'createdAt']],
	['mailArrivalOperations', 'by_expires', ['expiresAt']],
	['mailArrivalOperationChanges', 'by_operation', ['operationId']],
	['mailArrivalOperationChanges', 'by_message', ['messageId']],
	['mailArrivalOperationChanges', 'by_mailbox', ['mailboxId']],
	['mailArrivalOperationChanges', 'by_expires', ['expiresAt']],
	['mailRuleDrafts', 'by_mailbox_created', ['mailboxId', 'createdAt']],
	['mailRuleDrafts', 'by_expires', ['expiresAt']],
	['mailDelayedActions', 'by_state_run', ['state', 'runAt']],
	['mailDelayedActions', 'by_message', ['messageId']],
	['mailDelayedActions', 'by_thread_state', ['threadId', 'state']],
	['mailDelayedActions', 'by_action_key', ['actionKey']],
	['mailDelayedActions', 'by_mailbox', ['mailboxId']],
	['mailDigests', 'by_mailbox_period', ['mailboxId', 'periodKey']],
	['mailDigests', 'by_mailbox_state', ['mailboxId', 'state']],
	['mailDigests', 'by_expires', ['expiresAt']],
	['mailThreads', 'by_mailbox_digest_pending', ['mailboxId', 'digestPendingSince']],
	[
		'interpretSources',
		'by_mail_thread_upgradeable_order',
		['mailThreadId', 'isUpgradeable', 'sourceOrderKey'],
	],
];

describe('read on arrival tables and indexes', () => {
	it('lists every new table once for the tenant and deletion registries', () => {
		expect([...MAIL_ARRIVAL_TABLES].sort()).toEqual(Object.keys(mailArrivalTables).sort());
	});

	it.each(EXPECTED_INDEXES)('declares %s.%s on %j', (table, index, fields) => {
		expect(indexesOf(table)[index]).toEqual(fields);
	});
});

describe('read on arrival vocabularies', () => {
	it('match their validators', () => {
		expectTypeOf<Infer<typeof mailCategoryLabelValidator>>().toEqualTypeOf<MailCategory>();
		expectTypeOf<Infer<typeof placementValidator>>().toEqualTypeOf<Placement>();
		expectTypeOf<Infer<typeof senderStatusValidator>>().toEqualTypeOf<SenderStatus>();
		expectTypeOf<ArrivalOperationChangeRow>().toMatchTypeOf<ArrivalOperationChange>();
		expectTypeOf<ArrivalOperationChangeRow['kind']>().toEqualTypeOf<
			ArrivalOperationChange['kind']
		>();
		expect(mailCategoryLabelValidator.members.map((m) => m.value)).toHaveLength(7);
	});
});

async function seedOne() {
	const t = convexTest(schema, modules);
	const mailboxId = await seedMailbox(t);
	const folderId = await seedFolder(t, mailboxId);
	const messageId = await seedMessage(t, mailboxId, { fromAddress: 'news@example.com' });
	const threadId = await t.run(async (ctx) => (await ctx.db.get(messageId))!.threadId);
	return { t, mailboxId, folderId, messageId, threadId };
}

describe('read on arrival rows', () => {
	it('stores a realistic row in every new table and field', async () => {
		const { t, mailboxId, folderId, messageId, threadId } = await seedOne();
		await t.run(async (ctx) => {
			const ids = await seedArrivalRows(ctx, { mailboxId, threadId, messageId, folderId });
			const now = Date.now();
			await ctx.db.patch(threadId, {
				arrival: {
					placement: 'digest',
					depth: 'count',
					messageId,
					sourceOrderKey: 'k1',
					decidedAt: now,
				},
				digestPendingSince: now,
				digestConsumedThrough: 'k0',
				placementOverride: { placement: 'digest', setAt: now, operationId: ids.operationId },
				lastArrivalOperationId: ids.operationId,
				briefTop: {
					mode: 'brief',
					forYou: 0,
					waiting: 0,
					gist: { text: 'sealed:text', factQuote: 'sealed:fact' },
					revision: 1,
					updatedAt: now,
				},
			});
			await ctx.db.patch(messageId, { isOpenCounted: true });
			await ctx.db.patch(mailboxId, { interpretAutoBackfillAt: now });
			await ctx.db.insert('mailUserSettings', {
				userId: 'user-A',
				autoAdvance: 'next',
				isReadOnArrival: false,
				createdAt: now,
				updatedAt: now,
			});
			const ref = { threadKind: 'mail' as const, mailThreadId: threadId };
			await ctx.db.insert('threadBriefs', {
				...ref,
				mode: 'brief',
				sourceRevision: 1,
				interpretationRevision: 1,
				lastActivitySeq: 0,
				completeness: 'complete',
				deletionEpoch: 0,
				gist: {
					spans: [{ segmentId: 's0', quote: 'sealed:quote' }],
					fact: { kind: 'amount', quote: 'sealed:fact' },
					sourceKey: `mail:${messageId}`,
					gistVersion: 1,
					generatedAt: now,
				},
				skippedSources: 1,
				gistSources: 1,
				updatedAt: now,
			});
			await ctx.db.insert('interpretSources', {
				...ref,
				source: { kind: 'mail', id: messageId },
				sourceKey: `mail:${messageId}`,
				eligibility: {
					isLive: true,
					isThreadMuted: false,
					isBulkHeaderPresent: true,
					isSenderKnown: false,
				},
				sourceOrderKey: 'k1',
				depth: 'count',
				readOutcome: 'skipped',
				isUpgradeable: true,
				skipReason: { key: 'arrival.reason.budget' },
				categoryPendingAt: now,
				leaseUntil: now + 600_000,
				leaseToken: 'lease',
				createdAt: now,
				updatedAt: now,
			});
			const upgradeable = await ctx.db
				.query('interpretSources')
				.withIndex('by_mail_thread_upgradeable_order', (q) =>
					q.eq('mailThreadId', threadId).eq('isUpgradeable', true)
				)
				.collect();
			expect(upgradeable).toHaveLength(1);
			const thread = (await ctx.db.get(threadId)) as Doc<'mailThreads'>;
			expect(thread.arrival?.placement).toBe('digest');
		});
	});

	it('copies the message and label of a change to the indexed top level', () => {
		const ids = {
			operationId: 'op' as Id<'mailArrivalOperations'>,
			mailboxId: 'mb' as Id<'mailboxes'>,
		};
		const label = arrivalChangeRow({
			...ids,
			change: {
				kind: 'messageLabel',
				messageId: 'm1' as Id<'mailMessages'>,
				labelId: 'l1' as Id<'mailLabels'>,
				before: false,
				after: true,
			},
			now: 1000,
		});
		expect(label).toMatchObject({ messageId: 'm1', labelId: 'l1', createdAt: 1000 });
		expect(label.expiresAt).toBe(1000 + 30 * 24 * 60 * 60 * 1000);
		const sender = arrivalChangeRow({
			...ids,
			change: {
				kind: 'senderStatus',
				senderDigest: 'd',
				before: { status: 'keep', statusSource: 'default' },
				after: { status: 'digest', statusSource: 'user' },
			},
			now: 1000,
		});
		expect(sender.messageId).toBeUndefined();
		expect(sender.labelId).toBeUndefined();
		expect(sender.isNeedsReplyCleared).toBeUndefined();
	});
});

describe('new filter actions on the existing paths', () => {
	const filter = (actions: Doc<'mailFilters'>['actions']): Doc<'mailFilters'> =>
		({
			_id: 'f1',
			_creationTime: 0,
			mailboxId: 'mb',
			name: 'rule',
			isEnabled: true,
			priority: 1,
			conditions: [{ field: 'from', op: 'contains', value: 'news' }],
			actions,
			stopProcessing: false,
			createdAt: 0,
			updatedAt: 0,
		}) as unknown as Doc<'mailFilters'>;
	const message = {
		from: 'news@example.com',
		to: [],
		cc: [],
		subject: 's',
		size: 1,
		hasAttachment: false,
	};

	it('are explicit no-ops in the manual delivery pass', () => {
		const actions = ARRIVAL_FILTER_ACTION_TYPES.map((type) =>
			type === 'archiveAfter' ? { type, hours: 24 } : { type }
		);
		const outcome = resolveFilterOutcome([filter(actions)], message);
		expect(outcome).toEqual({
			pinnedSection: undefined,
			isDiscarded: false,
			isTrashed: false,
			folderId: undefined,
			labelIds: [],
			flagSeen: false,
			flagFlagged: false,
			filterForwardTo: [],
			manualPass: { winners: {} },
		});
		expect(evaluateFilters([filter(actions)], message).actions.map((a) => a.type)).toEqual([
			...ARRIVAL_FILTER_ACTION_TYPES,
		]);
		expect(evaluateFilters([filter(actions)], message).actions[3]?.hours).toBe(24);
	});

	it('are never retroactive', () => {
		expect(hasRetroactiveActions(filter([{ type: 'sendToDigest' }, { type: 'notify' }]))).toBe(
			false
		);
	});
});

describe('the wiring gate', () => {
	it('leaves no hook a stub', () => {
		expect([...ARRIVAL_HOOK_STUBS]).toEqual([]);
	});

	it('names an owning lane for every hook', () => {
		expect(Object.keys(ARRIVAL_HOOK_OWNERS).sort()).toEqual([
			'applyArrivalAiAnswers',
			'applySenderStatusAtDelivery',
			'compileFixRuleDraft',
			'evaluateArrivalRules',
			'listArrivalAiQuestions',
			'recordFirstOpen',
			'recordSenderDelivery',
		]);
	});
});
