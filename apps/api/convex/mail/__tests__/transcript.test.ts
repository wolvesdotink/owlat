/**
 * The one thread → prompt transcript builder (mail/ai/transcript.ts).
 *
 * Five builders used to disagree: only draft-on-arrival labelled whose message
 * was whose, and only the summarizer fell back to the HTML part, so HTML-only
 * mail reached classification and the clarification draft as its 200-char
 * snippet. These pin the shared rules, plus the two query callers that were
 * missing them.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import type { Doc, Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { buildThreadTranscript, TRIGGER_MARKER } from '../ai/transcript';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';

const OWNER = 'hello@acme.test';
const CUSTOMER = 'chris@example.com';

let seq = 0;
function msg(over: Partial<Doc<'mailMessages'>>): Doc<'mailMessages'> {
	seq += 1;
	return {
		_id: `msg${seq}` as Id<'mailMessages'>,
		fromAddress: CUSTOMER,
		toAddresses: [OWNER],
		subject: 'Listing paused',
		snippet: 'snippet only',
		...over,
	} as Doc<'mailMessages'>;
}

const BUDGET = { perMessageChars: 2000, totalChars: 12000 };

describe('buildThreadTranscript', () => {
	it('reads an HTML-only message as text, without script or style', async () => {
		const out = await buildThreadTranscript(
			[
				msg({
					htmlBodyInline:
						'<html><head><style>p { color: red }</style></head><body>' +
						'<p>Can you   confirm&nbsp;the <b>Friday</b> slot?</p>' +
						'<script>alert("x")</script></body></html>',
				}),
			],
			BUDGET
		);
		expect(out).toContain('Can you confirm the Friday slot?');
		expect(out).not.toContain('color: red');
		expect(out).not.toContain('alert');
		expect(out).not.toContain('<p>');
		expect(out).not.toContain('snippet only');
	});

	it('falls through a blank text part to the HTML, and to the snippet last', async () => {
		const blankText = await buildThreadTranscript(
			[msg({ textBodyInline: '  \n', htmlBodyInline: '<p>From the HTML part</p>' })],
			BUDGET
		);
		expect(blankText).toContain('From the HTML part');
		const nothing = await buildThreadTranscript([msg({})], BUDGET);
		expect(nothing).toContain('snippet only');
	});

	it('labels sides only when an owner address is given', async () => {
		const thread = [
			msg({ fromAddress: OWNER, fromName: 'Hello', textBodyInline: 'anything wrong?' }),
			msg({ textBodyInline: 'closing for winter' }),
		];
		const unlabelled = await buildThreadTranscript(thread, BUDGET);
		expect(unlabelled).toContain(`From: Hello <${OWNER}>\n`);
		expect(unlabelled).not.toContain('the mailbox owner');
		expect(unlabelled).not.toContain('the other party');

		const labelled = await buildThreadTranscript(thread, { ...BUDGET, ownerAddress: OWNER });
		expect(labelled).toContain(`From: Hello <${OWNER}> — the mailbox owner (you)`);
		expect(labelled).toContain(`From: ${CUSTOMER} — the other party`);
	});

	it('puts the trigger last under the marker', async () => {
		const trigger = msg({ textBodyInline: 'the question' });
		const out = await buildThreadTranscript(
			[msg({ textBodyInline: 'first' }), trigger, msg({ textBodyInline: 'a later aside' })],
			{ ...BUDGET, ownerAddress: OWNER, triggerId: trigger._id }
		);
		const marker = out.indexOf(TRIGGER_MARKER);
		expect(marker).toBeGreaterThan(out.indexOf('a later aside'));
		expect(out.slice(marker)).toContain('the question');
		expect(out.slice(marker)).not.toContain('first');
		expect(out.match(/the question/g)).toHaveLength(1);
	});

	it('trims the oldest messages first and keeps the trigger', async () => {
		const trigger = msg({ textBodyInline: 'TRIGGER BODY' });
		const older = Array.from({ length: 5 }, (_, i) =>
			msg({ textBodyInline: `old-${i} ${'x'.repeat(300)}` })
		);
		const out = await buildThreadTranscript([...older, trigger], {
			perMessageChars: 2000,
			totalChars: 1000,
			triggerId: trigger._id,
		});
		expect(out.length).toBeLessThanOrEqual(1000);
		expect(out).toContain('TRIGGER BODY');
		expect(out).not.toContain('old-0');
		expect(out).toContain('old-4');
	});

	it('without a trigger, trimming keeps the newest message', async () => {
		const out = await buildThreadTranscript(
			[msg({ textBodyInline: `oldest ${'x'.repeat(500)}` }), msg({ textBodyInline: 'newest' })],
			{ perMessageChars: 2000, totalChars: 200 }
		);
		expect(out).toContain('newest');
		expect(out).not.toContain('oldest');
	});

	it('caps each body and adds a To line only with includeTo', async () => {
		const m = msg({ textBodyInline: 'y'.repeat(50), toAddresses: [OWNER, 'b@example.com'] });
		const plain = await buildThreadTranscript([m], { perMessageChars: 10, totalChars: 1000 });
		expect(plain).not.toContain('To:');
		expect(plain.endsWith(`\n${'y'.repeat(10)}`)).toBe(true);
		const withTo = await buildThreadTranscript([m], { ...BUDGET, includeTo: true });
		expect(withTo).toContain(`\nTo: ${OWNER}, b@example.com\nSubject:`);
	});
});

/** A thread from `messages` (oldest first) flagged as needing a reply to the last one. */
async function seedFlaggedThread(
	t: TestConvex<typeof schema>,
	messages: Array<{ from: string; text?: string; html?: string }>
): Promise<Id<'mailThreads'>> {
	const mailboxId = await seedMailbox(t, { address: OWNER });
	await seedFolder(t, mailboxId, 'inbox');
	await seedFolder(t, mailboxId, 'sent');
	const base = Date.now() - messages.length * 60_000;
	const ids: Id<'mailMessages'>[] = [];
	for (const [index, m] of messages.entries()) {
		ids.push(
			await seedMessage(t, mailboxId, {
				subject: 'Listing paused',
				fromAddress: m.from,
				textBodyInline: m.text,
				htmlBodyInline: m.html,
				role: m.from === OWNER ? 'sent' : 'inbox',
				receivedAt: base + index * 60_000,
				rfc822MessageId: `<m${index}@acme.test>`,
			})
		);
	}
	let threadId!: Id<'mailThreads'>;
	await t.run(async (ctx) => {
		threadId = (await ctx.db.get(ids[0]!))!.threadId;
		for (const id of ids.slice(1)) await ctx.db.patch(id, { threadId });
		await ctx.db.patch(threadId, {
			latestMessageId: ids[ids.length - 1],
			needsReply: {
				messageId: ids[ids.length - 1]!,
				source: 'heuristic',
				urgency: 'normal',
				detectedAt: Date.now(),
				clarification: {
					isNeeded: false,
					askedAt: Date.now(),
					answeredAt: Date.now(),
					questions: [
						{
							id: 'q1',
							slotType: 'date',
							text: 'Which date?',
							attribution: 'Asked by chris@example.com',
							answer: { value: 'March 3', at: Date.now() },
						},
					],
				},
			},
		});
	});
	return threadId;
}

describe('query callers', () => {
	it('the clarification draft transcript labels sides and marks the flagged message', async () => {
		const t = convexTest(schema, modules);
		const threadId = await seedFlaggedThread(t, [
			{ from: OWNER, text: 'Hi Chris, we noticed you paused your listing — anything wrong?' },
			{ from: CUSTOMER, text: 'All good, we are closing for winter. When do you reopen?' },
		]);

		const context = await t.query(internal.mail.ai.needsReplyClarify.getClarificationContext, {
			threadId,
		});

		const transcript = context!.transcript;
		expect(transcript).toContain(`From: ${OWNER} — the mailbox owner (you)`);
		expect(transcript).toContain(`From: ${CUSTOMER} — the other party`);
		const marker = transcript.indexOf(TRIGGER_MARKER);
		expect(marker).toBeGreaterThan(transcript.indexOf('anything wrong?'));
		expect(transcript.slice(marker)).toContain('closing for winter');
	});

	it('needs-reply classification sees the body of an HTML-only message, labelled', async () => {
		const t = convexTest(schema, modules);
		const threadId = await seedFlaggedThread(t, [
			{ from: CUSTOMER, html: '<div>Could you send the <b>signed contract</b> by Friday?</div>' },
		]);

		const context = await t.query(internal.mail.needsReply.getThreadContext, { threadId });

		expect(context!.transcript).toContain('Could you send the signed contract by Friday?');
		expect(context!.transcript).toContain(`From: ${CUSTOMER} — the other party\nTo: `);
	});
});
