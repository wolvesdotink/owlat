/**
 * The draft-on-arrival loader (mail/ai/draftOnArrivalStore.ts::loadForDraft)
 * must only ever hand the draft model mail someone ELSE sent.
 *
 * On a synced team inbox the queue kept offering drafts that answered our own
 * outreach, written in the customer's voice: the transcript carried no hint of
 * which side wrote what, the flagged message was not marked as the one to
 * answer, and a reply we had already sent from the provider's client did not
 * stop the draft. These pin the three guards.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';

const OWNER = 'hello@acme.test';
const CUSTOMER = 'chris@example.com';

type Seeded = { threadId: Id<'mailThreads'>; ids: Id<'mailMessages'>[] };

/**
 * One thread holding `messages` in order (oldest first), flagged as needing a
 * reply to the message at `triggerIndex`.
 */
async function seedThread(
	t: TestConvex<typeof schema>,
	messages: Array<{ from: string; body: string; role?: 'inbox' | 'sent' }>,
	triggerIndex: number
): Promise<Seeded> {
	const mailboxId = await seedMailbox(t, { address: OWNER, kind: 'external', scope: 'shared' });
	await seedFolder(t, mailboxId, 'inbox');
	await seedFolder(t, mailboxId, 'sent');
	const base = Date.now() - messages.length * 60_000;
	const ids: Id<'mailMessages'>[] = [];
	for (const [index, m] of messages.entries()) {
		ids.push(
			await seedMessage(t, mailboxId, {
				subject: 'Listing paused',
				fromAddress: m.from,
				textBodyInline: m.body,
				role: m.role ?? (m.from === OWNER ? 'sent' : 'inbox'),
				receivedAt: base + index * 60_000,
				rfc822MessageId: `<m${index}@acme.test>`,
			})
		);
	}
	let threadId!: Id<'mailThreads'>;
	await t.run(async (ctx) => {
		const first = await ctx.db.get(ids[0]!);
		threadId = first!.threadId;
		for (const id of ids.slice(1)) await ctx.db.patch(id, { threadId });
		await ctx.db.patch(threadId, {
			latestMessageId: ids[ids.length - 1],
			needsReply: {
				messageId: ids[triggerIndex]!,
				source: 'heuristic',
				urgency: 'normal',
				detectedAt: Date.now(),
			},
		});
	});
	return { threadId, ids };
}

describe('loadForDraft only answers incoming mail', () => {
	it('labels each side and ends the transcript on the message being answered', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedThread(
			t,
			[
				{ from: OWNER, body: 'Hi Chris, we noticed you paused your listing — anything wrong?' },
				{ from: CUSTOMER, body: 'All good, we are closing for winter.' },
			],
			1
		);

		const loaded = await t.query(internal.mail.ai.draftOnArrivalStore.loadForDraft, { threadId });

		expect(loaded?.ownerAddress).toBe(OWNER);
		const context = loaded!.context;
		expect(context).toContain(`From: ${OWNER} — the mailbox owner (you)`);
		expect(context).toContain(`From: ${CUSTOMER} — the other party`);
		// The customer's message is the one to answer, and it comes last.
		const marker = context.indexOf('=== The message to reply to ===');
		expect(marker).toBeGreaterThan(context.indexOf('anything wrong?'));
		expect(context.slice(marker)).toContain('closing for winter');
		expect(context.slice(marker)).not.toContain('anything wrong?');
	});

	it('refuses a trigger the owner wrote', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedThread(
			t,
			[
				{ from: CUSTOMER, body: 'Can you check my listing?' },
				{ from: OWNER, body: 'Hi Chris, done — anything else?' },
			],
			1
		);

		expect(
			await t.query(internal.mail.ai.draftOnArrivalStore.loadForDraft, { threadId })
		).toBeNull();
	});

	it('refuses once the owner already answered the trigger from another client', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedThread(
			t,
			[
				{ from: CUSTOMER, body: 'Why did you think we removed the listing?' },
				{ from: OWNER, body: 'Sorry, my mistake — it is still live.' },
			],
			0
		);

		expect(
			await t.query(internal.mail.ai.draftOnArrivalStore.loadForDraft, { threadId })
		).toBeNull();
	});
});
