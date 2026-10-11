/**
 * The Reply Queue's stage-2 decision rule (mail/ai/replyIntent.ts): which
 * named intents belong in the queue, and what the guidance has to keep telling
 * the model so it names them correctly.
 */
import { describe, it, expect } from 'vitest';
import {
	DECISION_RULES,
	INTENT_GUIDE,
	REPLY_INTENTS,
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

// The guidance the interpretation prompt carries (mail/interpret/prompt.ts).
describe('the reply-intent guidance', () => {
	const prompt = `${INTENT_GUIDE}\n${DECISION_RULES.join('\n')}`;

	it('defines every intent the schema accepts', () => {
		for (const intent of REPLY_INTENTS) {
			expect(prompt).toContain(`- ${intent satisfies ReplyIntent}:`);
		}
	});

	it('spells out the rule the meeting-notes bug needed', () => {
		expect(prompt).toContain('INSIDE a recap');
		expect(prompt).toContain('informational_update');
	});

	// A team inbox: the customer sends the billing address the team asked for
	// and waits for the invoice. "Doing a task it mentions is not replying" read
	// that as FYI; the task here IS the email back.
	it('counts a task whose result goes back to the sender by email as a reply', () => {
		expect(prompt).toContain('waiting to RECEIVE something from the reader by email');
		expect(prompt).toContain('only supplies details the reader asked them for');
		expect(prompt).toContain('Doing a task rules out a reply only when nothing goes back');
	});

	// Cold pitches ("quick question about your website") end in a question and
	// were drafted like customer mail.
	it('files unsolicited sales outreach as broadcast even when it asks a question', () => {
		expect(prompt).toContain('cold outreach');
		expect(prompt).toContain('The question is a sales device');
	});

	it('never lets an unattended address expect a reply', () => {
		expect(prompt).toContain('unattended address');
	});
});
