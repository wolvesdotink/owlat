/**
 * The one evaluation algebra (SPEC §6.2): the arrival hook pass on both live
 * ingest paths, the pending AI questions, and R2's answers. Ordering,
 * `stopProcessing`, exclusive winners across the manual pass, the hook pass,
 * sender status and late answers, revisions, unknown answers, idempotence,
 * and the `rule_apply` log written with every change.
 */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../../schema';
import { modules } from '../../__tests__/helpers.testlib';
import { ARRIVAL_HOOK_STUBS, listArrivalAiQuestions } from '../../arrival/hooks';
import { MAX_PENDING_AI_FILTERS } from '../rulesPass';
import {
	answer,
	deliverHosted,
	ingestSynced,
	messageOf,
	operationsOf,
	recordOf,
	roleOf,
	seedExternalMailbox,
	seedFilter,
	seedLabel,
	seedPersonalMailbox,
	seedProfile,
	seedUserFolder,
} from './rules.testlib';

describe('the rules hooks', () => {
	it('are no longer stubs', () => {
		expect(ARRIVAL_HOOK_STUBS.size).toBe(0);
	});
});

describe('the hook pass at hosted delivery', () => {
	it('applies a plain-language rule and logs it as one rule_apply operation', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		const labelId = await seedLabel(t, mailboxId);
		const filterId = await seedFilter(t, mailboxId, {
			actions: [{ type: 'markFlagged' }, { type: 'addLabel', labelId }, { type: 'markRead' }],
		});
		const id = (await deliverHosted(t))!;
		const message = await messageOf(t, id);
		expect(message.flagFlagged).toBe(true);
		expect(message.flagSeen).toBe(true);
		expect(message.labelIds).toEqual([labelId]);
		const record = (await recordOf(t, id))!;
		expect(record.filterMatches).toEqual([{ filterId, revision: 0, pass: 'deterministic' }]);
		const [operation, ...rest] = await operationsOf(t, mailboxId);
		expect(rest).toHaveLength(0);
		expect(operation).toMatchObject({
			kind: 'rule_apply',
			actor: 'rule',
			messageId: id,
			filterId,
			changeCount: 3,
		});
		expect(operation!.changes.map((row) => row.change.kind).sort()).toEqual([
			'messageFlag',
			'messageLabel',
			'messageRead',
		]);
	});

	it('runs in priority order and stops at a stopProcessing rule', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		const first = await seedLabel(t, mailboxId, 'First');
		const later = await seedLabel(t, mailboxId, 'Later');
		await seedFilter(t, mailboxId, {
			priority: 300,
			actions: [{ type: 'addLabel', labelId: later }],
		});
		await seedFilter(t, mailboxId, {
			priority: 200,
			stopProcessing: true,
			actions: [{ type: 'addLabel', labelId: first }],
		});
		const id = (await deliverHosted(t))!;
		expect((await messageOf(t, id)).labelIds).toEqual([first]);
	});

	it('lets a manual rule that stopped processing stop the later hook rules', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		const manual = await seedLabel(t, mailboxId, 'Manual');
		await seedFilter(t, mailboxId, {
			origin: undefined,
			priority: 50,
			stopProcessing: true,
			actions: [{ type: 'addLabel', labelId: manual }],
		});
		await seedFilter(t, mailboxId, { priority: 100, actions: [{ type: 'markFlagged' }] });
		const id = (await deliverHosted(t))!;
		const message = await messageOf(t, id);
		expect(message.labelIds).toEqual([manual]);
		expect(message.flagFlagged).toBe(false);
	});

	it('keeps plain-language and AI rules out of the manual pass', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		const finance = await seedUserFolder(t, mailboxId, 'Finance');
		await seedFilter(t, mailboxId, {
			conditions: [],
			aiCondition: { question: 'Is this an invoice?', revision: 0 },
			actions: [{ type: 'moveToFolder', folderId: finance }],
		});
		const id = (await deliverHosted(t))!;
		// Waiting for its answer: nothing moved.
		expect(await roleOf(t, id)).toBe('inbox');
		expect((await recordOf(t, id))!.pendingAiFilters).toHaveLength(1);
	});

	it('ranks the folder by priority against the manual pass', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		const manualFolder = await seedUserFolder(t, mailboxId, 'Manual');
		const ruleFolder = await seedUserFolder(t, mailboxId, 'Rule');
		const manualId = await seedFilter(t, mailboxId, {
			origin: undefined,
			priority: 300,
			actions: [{ type: 'moveToFolder', folderId: manualFolder }],
		});
		const ruleId = await seedFilter(t, mailboxId, {
			priority: 100,
			actions: [{ type: 'moveToFolder', folderId: ruleFolder }],
		});
		const id = (await deliverHosted(t))!;
		expect((await messageOf(t, id)).folderId).toBe(ruleFolder);
		expect((await recordOf(t, id))!.exclusiveWinners?.folder).toEqual({
			source: 'hook',
			filterId: ruleId,
			priority: 100,
		});

		// A hook rule ranked after the manual one leaves the manual folder alone.
		await t.run(async (ctx) => await ctx.db.patch(ruleId, { priority: 400 }));
		const second = (await deliverHosted(t))!;
		expect((await messageOf(t, second)).folderId).toBe(manualFolder);
		expect((await recordOf(t, second))!.exclusiveWinners?.folder).toEqual({
			source: 'manual',
			filterId: manualId,
			priority: 300,
		});
	});

	it('beats sender status for the folder, and sender status does not overwrite the winner', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		await seedProfile(t, mailboxId, { status: 'auto_archive', statusSource: 'user' });
		const finance = await seedUserFolder(t, mailboxId, 'Finance');
		await seedFilter(t, mailboxId, { actions: [{ type: 'moveToFolder', folderId: finance }] });
		const id = (await deliverHosted(t))!;
		expect((await messageOf(t, id)).folderId).toBe(finance);
		expect((await recordOf(t, id))!.exclusiveWinners?.folder?.source).toBe('hook');
	});

	it('records a placement on the record with its undo guard', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		await seedFilter(t, mailboxId, { actions: [{ type: 'sendToDigest' }] });
		const id = (await deliverHosted(t))!;
		const record = (await recordOf(t, id))!;
		expect(record.rulePlacement).toBe('digest');
		const [operation] = await operationsOf(t, mailboxId);
		expect(record.lastOperationId).toBe(operation!._id);
		expect(operation!.changes[0]!.change).toEqual({
			kind: 'recordRulePlacement',
			messageId: id,
			before: null,
			after: 'digest',
		});
		// Placement-only: the message stays where it is.
		expect(await roleOf(t, id)).toBe('inbox');
		const { threadId } = await messageOf(t, id);
		const thread = await t.run(async (ctx) => await ctx.db.get(threadId));
		expect(thread?.arrival?.placement).toBe('digest');
	});

	it('does nothing for a team inbox', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t, { scope: 'shared' });
		await seedFilter(t, mailboxId, { actions: [{ type: 'markFlagged' }] });
		const id = (await deliverHosted(t))!;
		expect((await messageOf(t, id)).flagFlagged).toBe(false);
		expect(await operationsOf(t, mailboxId)).toHaveLength(0);
	});

	it('caps the pending questions at five, highest priority first', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		for (let i = 0; i < 7; i += 1) {
			await seedFilter(t, mailboxId, {
				priority: 700 - i * 100,
				aiCondition: { question: `Question ${i}?`, revision: 0 },
			});
		}
		const id = (await deliverHosted(t))!;
		const pending = (await recordOf(t, id))!.pendingAiFilters!;
		expect(pending).toHaveLength(MAX_PENDING_AI_FILTERS);
		expect(pending[0]!.question).toBe('Question 6?');
		const questions = await t.run(
			async (ctx) => await listArrivalAiQuestions(ctx, { mailboxId, messageId: id })
		);
		expect(questions).toEqual(pending);
	});
});

describe('the hook pass at external sync', () => {
	it('applies on forward sync with provider writeback, never on a backfill', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { accountId, mailboxId } = await seedExternalMailbox(t);
		const finance = await seedUserFolder(t, mailboxId, 'Finance');
		await seedFilter(t, mailboxId, { actions: [{ type: 'moveToFolder', folderId: finance }] });
		const live = (await ingestSynced(t, accountId, { uid: 1 }))!;
		expect((await messageOf(t, live)).folderId).toBe(finance);
		const remote = await t.run(
			async (ctx) => await ctx.db.query('externalMailRemoteOps').collect()
		);
		expect(remote.some((op) => op.kind === 'move')).toBe(true);

		const old = (await ingestSynced(t, accountId, { uid: 2, origin: 'backfill' }))!;
		expect(await roleOf(t, old)).toBe('inbox');
	});
});

describe('R2 answers', () => {
	async function pendingSetup() {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId, folders } = await seedPersonalMailbox(t);
		const finance = await seedUserFolder(t, mailboxId, 'Finance');
		const filterId = await seedFilter(t, mailboxId, {
			aiCondition: { question: 'Is this an invoice?', revision: 0 },
			actions: [{ type: 'moveToFolder', folderId: finance }, { type: 'placeInUpdates' }],
		});
		const id = (await deliverHosted(t))!;
		return { t, mailboxId, folders, finance, filterId, id };
	}

	it('applies a yes in priority order, logged, and records the match', async () => {
		const { t, mailboxId, finance, filterId, id } = await pendingSetup();
		await answer(t, id, [{ filterId, revision: 0, answer: true }]);
		expect((await messageOf(t, id)).folderId).toBe(finance);
		const record = (await recordOf(t, id))!;
		expect(record.pendingAiFilters).toBeUndefined();
		expect(record.filterMatches).toEqual([{ filterId, revision: 0, pass: 'ai', answer: true }]);
		expect(record.rulePlacement).toBe('updates');
		expect(record.exclusiveWinners?.folder?.source).toBe('ai');
		const operations = await operationsOf(t, mailboxId);
		expect(operations).toHaveLength(1);
		expect(operations[0]!.changes.map((row) => row.change.kind).sort()).toEqual([
			'messageFolder',
			'recordRulePlacement',
		]);
		expect(record.lastOperationId).toBe(operations[0]!._id);
	});

	it('is idempotent: the same answers again change nothing', async () => {
		const { t, mailboxId, filterId, id } = await pendingSetup();
		await answer(t, id, [{ filterId, revision: 0, answer: true }]);
		await answer(t, id, [{ filterId, revision: 0, answer: true }]);
		expect(await operationsOf(t, mailboxId)).toHaveLength(1);
		expect((await recordOf(t, id))!.filterMatches).toHaveLength(1);
	});

	it('counts an unknown answer as no match', async () => {
		const { t, mailboxId, filterId, id } = await pendingSetup();
		await answer(t, id, [{ filterId, revision: 0, answer: null }]);
		expect(await roleOf(t, id)).toBe('inbox');
		expect((await recordOf(t, id))!.filterMatches).toEqual([
			{ filterId, revision: 0, pass: 'ai', answer: null },
		]);
		expect(await operationsOf(t, mailboxId)).toHaveLength(0);
	});

	it('drops an answer for an edited rule (a new revision)', async () => {
		const { t, mailboxId, filterId, id } = await pendingSetup();
		await t.run(async (ctx) => await ctx.db.patch(filterId, { revision: 1 }));
		await answer(t, id, [{ filterId, revision: 0, answer: true }]);
		expect(await roleOf(t, id)).toBe('inbox');
		expect((await recordOf(t, id))!.filterMatches).toEqual([
			{ filterId, revision: 0, pass: 'ai', answer: null },
		]);
		expect(await operationsOf(t, mailboxId)).toHaveLength(0);
	});

	it('ignores an answer for a question this message never had', async () => {
		const { t, mailboxId, id } = await pendingSetup();
		const other = await seedFilter(t, mailboxId, {
			aiCondition: { question: 'Other?', revision: 0 },
		});
		await answer(t, id, [{ filterId: other, revision: 0, answer: true }]);
		expect((await recordOf(t, id))!.pendingAiFilters).toHaveLength(1);
		expect(await operationsOf(t, mailboxId)).toHaveLength(0);
	});

	it('loses the folder to an earlier, lower-numbered winner', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		const early = await seedUserFolder(t, mailboxId, 'Early');
		const late = await seedUserFolder(t, mailboxId, 'Late');
		await seedFilter(t, mailboxId, {
			priority: 100,
			actions: [{ type: 'moveToFolder', folderId: early }],
		});
		const filterId = await seedFilter(t, mailboxId, {
			priority: 200,
			aiCondition: { question: 'Invoice?', revision: 0 },
			actions: [{ type: 'moveToFolder', folderId: late }, { type: 'markFlagged' }],
		});
		const id = (await deliverHosted(t))!;
		await answer(t, id, [{ filterId, revision: 0, answer: true }]);
		const message = await messageOf(t, id);
		expect(message.folderId).toBe(early);
		// Non-exclusive actions always apply.
		expect(message.flagFlagged).toBe(true);
	});

	it('moves an auto-archived sender’s mail: sender status ranks after every rule', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		await seedProfile(t, mailboxId, { status: 'auto_archive', statusSource: 'user' });
		const finance = await seedUserFolder(t, mailboxId, 'Finance');
		const filterId = await seedFilter(t, mailboxId, {
			aiCondition: { question: 'Invoice?', revision: 0 },
			actions: [{ type: 'moveToFolder', folderId: finance }],
		});
		const id = (await deliverHosted(t))!;
		expect(await roleOf(t, id)).toBe('archive');
		expect((await recordOf(t, id))!.exclusiveWinners?.folder?.source).toBe('sender_status');
		await answer(t, id, [{ filterId, revision: 0, answer: true }]);
		expect((await messageOf(t, id)).folderId).toBe(finance);
	});

	it('never moves mail back out of a folder the person filed it into', async () => {
		const { t, mailboxId, filterId, id } = await pendingSetup();
		const elsewhere = await seedUserFolder(t, mailboxId, 'Elsewhere');
		await t.run(async (ctx) => await ctx.db.patch(id, { folderId: elsewhere }));
		await answer(t, id, [{ filterId, revision: 0, answer: true }]);
		expect((await messageOf(t, id)).folderId).toBe(elsewhere);
	});
});
