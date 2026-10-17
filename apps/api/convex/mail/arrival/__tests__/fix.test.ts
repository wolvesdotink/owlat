/**
 * Fix (SPEC §4.2): every destination × scope writes its change and its
 * operation rows in the same mutation, stamps the ABA markers, re-sorts a
 * sender's newest ≤200 Inbox messages only, never writes a category, and a
 * reason starts a rule-draft compile.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { api } from '../../../_generated/api';
import { modules } from '../../__tests__/helpers.testlib';
import { openMessageBody } from '../../../lib/messageBody';
import {
	SENDER,
	deliverLive,
	operationOf,
	profileOf,
	roleOf,
	seedPersonalMailbox,
	seedProfile,
	seedSenderMessages,
	threadOf,
} from './learn.testlib';

vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner' as const, activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
	};
});

describe('fix.apply, message scope', () => {
	it('sets the thread override, logs it and stamps the thread', async () => {
		const t = convexTest(schema, modules);
		await seedPersonalMailbox(t);
		const { message, thread } = await deliverLive(t);
		const categoryBefore = thread.category;

		const result = await t.mutation(api.mail.arrival.fix.apply, {
			messageId: message._id,
			destination: 'updates',
			scope: 'message',
		});
		const after = await threadOf(t, thread._id);
		expect(after.placementOverride).toMatchObject({
			placement: 'updates',
			operationId: result.operationId,
		});
		expect(after.lastArrivalOperationId).toBe(result.operationId);
		expect(after.arrival?.placement).toBe('updates');
		expect(after.category).toEqual(categoryBefore); // no category writes

		const { operation, changes } = await operationOf(t, result.operationId!);
		expect(operation).toMatchObject({
			kind: 'fix',
			actor: 'user',
			threadId: thread._id,
			messageId: message._id,
			changeCount: 1,
			status: 'applied',
		});
		expect(changes.map((row) => row.change)).toEqual([
			{
				kind: 'threadPlacementOverride',
				threadId: thread._id,
				before: null,
				after: after.placementOverride,
			},
		]);
	});

	it('archives the thread now for auto_archive, one messageFolder row per message', async () => {
		const t = convexTest(schema, modules);
		const { folders } = await seedPersonalMailbox(t);
		const { message, thread } = await deliverLive(t);
		await t.run(async (ctx) => {
			await ctx.db.patch(thread._id, {
				needsReply: {
					messageId: message._id,
					source: 'llm',
					urgency: 'normal',
					detectedAt: Date.now(),
				},
			});
		});
		const result = await t.mutation(api.mail.arrival.fix.apply, {
			messageId: message._id,
			destination: 'auto_archive',
			scope: 'message',
		});
		expect(result).toMatchObject({ archived: 1, isNeedsReplyCleared: true });
		expect(await roleOf(t, message._id)).toBe('archive');
		const { changes } = await operationOf(t, result.operationId!);
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({
			change: {
				kind: 'messageFolder',
				messageId: message._id,
				before: folders.inbox,
				after: folders.archive,
			},
			isNeedsReplyCleared: true,
			messageId: message._id,
		});
	});

	it('writes no operation when nothing changes and there is no reason', async () => {
		const t = convexTest(schema, modules);
		await seedPersonalMailbox(t);
		const { message } = await deliverLive(t);
		const args = {
			messageId: message._id,
			destination: 'today' as const,
			scope: 'message' as const,
		};
		expect((await t.mutation(api.mail.arrival.fix.apply, args)).operationId).not.toBeNull();
		expect((await t.mutation(api.mail.arrival.fix.apply, args)).operationId).toBeNull();
		const operations = await t.run(async (ctx) => ctx.db.query('mailArrivalOperations').collect());
		expect(operations).toHaveLength(1);
	});

	it('brings an auto-archived message back to the Inbox when the person places it', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedPersonalMailbox(t);
		await seedProfile(t, mailboxId, { status: 'auto_archive', statusSource: 'user' });
		const { message } = await deliverLive(t);
		expect(await roleOf(t, message._id)).toBe('archive');
		const result = await t.mutation(api.mail.arrival.fix.apply, {
			messageId: message._id,
			destination: 'needs_me',
			scope: 'message',
		});
		expect(await roleOf(t, message._id)).toBe('inbox');
		const { changes } = await operationOf(t, result.operationId!);
		expect(changes.map((row) => row.change.kind).sort()).toEqual([
			'messageFolder',
			'threadPlacementOverride',
		]);
	});
});

describe('fix.apply, sender scope', () => {
	it('sets the sender override and turns a digest status back to keep', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedPersonalMailbox(t);
		await seedProfile(t, mailboxId, { status: 'digest', statusSource: 'learned' });
		const { message, thread } = await deliverLive(t);

		const result = await t.mutation(api.mail.arrival.fix.apply, {
			messageId: message._id,
			destination: 'needs_me',
			scope: 'sender',
		});
		const profile = (await profileOf(t, mailboxId))!;
		expect(profile).toMatchObject({
			status: 'keep',
			statusSource: 'user',
			placementOverride: 'needs_me',
			placementOverrideOperationId: result.operationId,
			lastOperationId: result.operationId,
		});
		expect((await threadOf(t, thread._id)).arrival?.placement).toBe('needs_me');
		const { operation, changes } = await operationOf(t, result.operationId!);
		expect(operation).toMatchObject({ senderDigest: profile.senderDigest, changeCount: 2 });
		expect(changes.map((row) => row.change)).toEqual([
			{
				kind: 'senderStatus',
				senderDigest: profile.senderDigest,
				before: { status: 'digest', statusSource: 'learned' },
				after: { status: 'keep', statusSource: 'user' },
			},
			{
				kind: 'senderPlacementOverride',
				senderDigest: profile.senderDigest,
				before: null,
				after: 'needs_me',
			},
		]);
	});

	it('sets status digest and re-sorts only the newest 200 Inbox messages', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, folders } = await seedPersonalMailbox(t);
		const { message } = await deliverLive(t);
		await seedSenderMessages(
			t,
			mailboxId,
			folders.inbox,
			Array.from({ length: 205 }, (_, i) => 1_000 + i)
		);
		const result = await t.mutation(api.mail.arrival.fix.apply, {
			messageId: message._id,
			destination: 'digest',
			scope: 'sender',
		});
		expect(result.resorted).toBe(200);
		expect((await profileOf(t, mailboxId))!).toMatchObject({
			status: 'digest',
			statusSource: 'user',
		});
	});

	it('auto_archive archives the newest 200 Inbox messages of the sender, logged', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, folders } = await seedPersonalMailbox(t);
		const { message } = await deliverLive(t);
		const old = await seedSenderMessages(
			t,
			mailboxId,
			folders.inbox,
			Array.from({ length: 205 }, (_, i) => 1_000 + i)
		);
		const result = await t.mutation(api.mail.arrival.fix.apply, {
			messageId: message._id,
			destination: 'auto_archive',
			scope: 'sender',
		});
		expect(result.archived).toBe(200);
		expect(await roleOf(t, message._id)).toBe('archive');
		// The five oldest stay where they are: no continuation.
		for (const id of old.slice(0, 5)) expect(await roleOf(t, id)).toBe('inbox');
		const { operation, changes } = await operationOf(t, result.operationId!);
		expect(operation.changeCount).toBe(201);
		expect(changes.filter((row) => row.change.kind === 'messageFolder')).toHaveLength(200);
	});

	it('refuses the owner own mail and a team inbox', async () => {
		const t = convexTest(schema, modules);
		await seedPersonalMailbox(t, { scope: 'shared' });
		const { message } = await deliverLive(t);
		await expect(
			t.mutation(api.mail.arrival.fix.apply, {
				messageId: message._id,
				destination: 'updates',
				scope: 'sender',
			})
		).rejects.toThrow();
	});
});

describe('fix.apply, reason', () => {
	it('stores the reason sealed and starts a compiling rule draft', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedPersonalMailbox(t);
		const { message } = await deliverLive(t);
		const result = await t.mutation(api.mail.arrival.fix.apply, {
			messageId: message._id,
			destination: 'needs_me',
			scope: 'message',
			reason: '  Delays on trips I am booked on matter to me  ',
		});
		expect(result.ruleDraftId).not.toBeNull();
		const { operation } = await operationOf(t, result.operationId!);
		// Stored through the at-rest seal (a passthrough without a key in tests).
		expect(await openMessageBody(operation.reason!)).toBe(
			'Delays on trips I am booked on matter to me'
		);
		const drafts = await t.run(async (ctx) => ctx.db.query('mailRuleDrafts').collect());
		expect(drafts).toHaveLength(1);
		expect(drafts[0]).toMatchObject({
			mailboxId,
			status: 'compiling',
			origin: 'fix',
			fromMessageId: message._id,
		});
		expect(await openMessageBody(drafts[0]!.sourceText)).toBe(
			'Delays on trips I am booked on matter to me'
		);
		const scheduled = await t.run(async (ctx) =>
			ctx.db.system.query('_scheduled_functions').collect()
		);
		expect(scheduled.map((job) => job.name)).toContain('mail/arrival/fixCompile:compile');
	});
});

it('keeps the sender address in the result for the toast', async () => {
	const t = convexTest(schema, modules);
	await seedPersonalMailbox(t);
	const { message } = await deliverLive(t);
	const result = await t.mutation(api.mail.arrival.fix.apply, {
		messageId: message._id,
		destination: 'updates',
		scope: 'sender',
	});
	expect(result).toMatchObject({ address: SENDER, displayName: 'Shop' });
});
