/**
 * The Reply Queue screen treats a mailbox's aliases as the mailbox itself.
 *
 * A team inbox reached through an alias (`info@` → the team inbox) receives
 * customer mail addressed to the alias, not to the mailbox's canonical address.
 * The screen compared against the canonical address only, so every such mail
 * failed `not_in_to` and never reached the queue, and a reply sent from the
 * alias read as the customer's and left the flag standing.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';
import { evaluateNeedsReplyCandidate } from '../needsReplyHeuristic';
import { clearNeedsReplyOnOwnerReply } from '../needsReply';

const TEAM = 'team@owlat.test';
const ALIAS = 'info@owlat.test';
const CUSTOMER = 'sam@acme.test';

async function seedAliasedInbox(
	t: TestConvex<typeof schema>,
	opts: { withAlias: boolean }
): Promise<{
	mailboxId: Id<'mailboxes'>;
	messageId: Id<'mailMessages'>;
	threadId: Id<'mailThreads'>;
}> {
	const mailboxId = await seedMailbox(t, { address: TEAM, scope: 'shared', kind: 'external' });
	await seedFolder(t, mailboxId, 'inbox');
	const messageId = await seedMessage(t, mailboxId, {
		subject: 'Can I still book for Friday?',
		fromAddress: CUSTOMER,
	});
	const threadId = await t.run(async (ctx) => {
		const message = (await ctx.db.get(messageId))!;
		await ctx.db.patch(messageId, { toAddresses: [ALIAS] });
		await ctx.db.patch(message.threadId, { latestMessageId: messageId });
		if (opts.withAlias) {
			await ctx.db.insert('mailAliases', {
				alias: ALIAS,
				targetMailboxId: mailboxId,
				organizationId: 'org-1',
				createdAt: Date.now(),
			});
		}
		return message.threadId;
	});
	return { mailboxId, messageId, threadId };
}

async function evaluate(t: TestConvex<typeof schema>, threadId: Id<'mailThreads'>) {
	const context = await t.query(internal.mail.needsReply.getThreadContext, { threadId });
	expect(context).not.toBeNull();
	return evaluateNeedsReplyCandidate({
		ownerAddresses: context!.ownerAddresses,
		messages: context!.messages,
	});
}

describe('Reply Queue screen and mailbox aliases', () => {
	it('queues customer mail addressed to an alias of the mailbox', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedAliasedInbox(t, { withAlias: true });

		expect(await evaluate(t, threadId)).toEqual({ candidate: true, latestInboundIndex: 0 });
	});

	it('CONTROL: the same mail to an address that is not the mailbox stays out', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedAliasedInbox(t, { withAlias: false });

		expect(await evaluate(t, threadId)).toEqual({ candidate: false, reason: 'not_in_to' });
	});

	it('a reply sent from the alias settles the flag', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await seedAliasedInbox(t, { withAlias: true });
		const replyId = await t.run(async (ctx) => {
			const trigger = (await ctx.db.get(messageId))!;
			await ctx.db.patch(threadId, {
				needsReply: { messageId, source: 'llm', urgency: 'normal', detectedAt: Date.now() },
			});
			const { _id: _ignored, _creationTime: _ignoredTime, ...fields } = trigger;
			return await ctx.db.insert('mailMessages', {
				...fields,
				mailboxId,
				uid: 2,
				rfc822MessageId: '<reply@owlat.test>',
				fromAddress: ALIAS,
				toAddresses: [CUSTOMER],
				receivedAt: trigger.receivedAt + 60_000,
			});
		});

		await t.run(async (ctx) => clearNeedsReplyOnOwnerReply(ctx, replyId));

		await t.run(async (ctx) => {
			expect((await ctx.db.get(threadId))!.needsReply).toBeUndefined();
		});
	});
});
