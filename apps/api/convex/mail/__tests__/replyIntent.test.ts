/**
 * The Reply Queue's stage-2 decision rule (mail/ai/replyIntent.ts): which
 * named intents belong in the queue, and what the prompt has to keep telling
 * the cheap tier so it names them correctly.
 */
import { describe, it, expect } from 'vitest';
import {
	REPLY_INTENTS,
	buildReplyIntentPrompt,
	decideNeedsReply,
	isReplyExpectingIntent,
	type ReplyIntent,
} from '../ai/replyIntent';

describe('isReplyExpectingIntent', () => {
	it('keeps the five intents where the sender waits for an email back', () => {
		const expecting = REPLY_INTENTS.filter(isReplyExpectingIntent);
		expect(expecting).toEqual([
			'direct_question',
			'request_for_action',
			'approval_or_decision',
			'scheduling',
			'personal_message',
		]);
	});

	it('treats every informational / automated / bulk intent as read-only', () => {
		for (const intent of [
			'informational_update',
			'automated_notification',
			'transactional_receipt',
			'broadcast',
			'acknowledgement',
		] as const) {
			expect(isReplyExpectingIntent(intent)).toBe(false);
		}
	});
});

describe('decideNeedsReply', () => {
	const base = { modelNeedsReply: true, isUnattendedSender: false };

	it('queues a genuine ask', () => {
		expect(decideNeedsReply({ ...base, intent: 'direct_question' })).toEqual({ needsReply: true });
	});

	it('drops a recap even when the model claims it needs a reply', () => {
		// The meeting-notes bug: to-dos inside a summary made the model answer
		// "yes", so the intent — not the boolean — has the final say.
		expect(decideNeedsReply({ ...base, intent: 'informational_update' })).toEqual({
			needsReply: false,
			suppressedBy: 'intent',
		});
	});

	it('honours the model as a veto on a reply-expecting intent', () => {
		expect(
			decideNeedsReply({ ...base, intent: 'direct_question', modelNeedsReply: false })
		).toEqual({ needsReply: false, suppressedBy: 'model' });
	});

	it('never queues a reply to an unattended sender, whatever the intent', () => {
		for (const intent of REPLY_INTENTS) {
			expect(decideNeedsReply({ ...base, intent, isUnattendedSender: true })).toEqual({
				needsReply: false,
				suppressedBy: 'unattended_sender',
			});
		}
	});
});

describe('buildReplyIntentPrompt', () => {
	const prompt = buildReplyIntentPrompt({
		systemGuard: 'GUARD',
		ownerAddress: 'me@example.com',
		transcript: 'From: alice@example.com\nHello',
		senderLooksAutomated: false,
	});

	it('leads with the untrusted-data guard and frames the thread as data', () => {
		expect(prompt.startsWith('GUARD')).toBe(true);
		expect(prompt).toContain('From: alice@example.com');
	});

	it('defines every intent the schema accepts', () => {
		for (const intent of REPLY_INTENTS) {
			expect(prompt).toContain(`- ${intent satisfies ReplyIntent}:`);
		}
	});

	it('spells out the rule the meeting-notes bug needed', () => {
		expect(prompt).toContain('INSIDE a recap');
		expect(prompt).toContain('informational_update');
	});

	it('warns the model when the sender looks like a publishing mailbox', () => {
		const automated = buildReplyIntentPrompt({
			systemGuard: 'GUARD',
			ownerAddress: 'me@example.com',
			transcript: 'x',
			senderLooksAutomated: true,
		});
		expect(automated).toContain('automated/publishing mailbox');
		expect(prompt).not.toContain('automated/publishing mailbox');
	});
});
