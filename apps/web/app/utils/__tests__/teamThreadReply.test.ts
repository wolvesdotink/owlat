import { describe, expect, it } from 'vitest';
import {
	REPLY_BLOCKER_KEYS,
	REPLY_NOTICE_KEYS,
	classificationSummary,
	hasAgentDraft,
	isChannelMessage,
	isFollowUp,
	latestClassification,
	needsTakeOver,
	replyNotice,
	otherWaitingDrafts,
	replySubject,
	pickReplyTarget,
	replyBlocker,
} from '../teamThreadReply';

const msg = (id: string, at: number, processingStatus: string, draftResponse?: string) => ({
	_id: id,
	_creationTime: at,
	processingStatus,
	...(draftResponse !== undefined ? { draftResponse } : {}),
});

describe('replyBlocker', () => {
	it('lets a person reply to a waiting draft and to a message the agent failed', () => {
		expect(replyBlocker('draft_ready')).toBeNull();
		expect(replyBlocker('failed')).toBeNull();
	});

	it('lets a person reply when the agent is off and the scan has stopped the pipeline', () => {
		expect(replyBlocker('security_check', { agentEnabled: false, scanFinished: true })).toBeNull();
		// The scan is still running: the server refuses, so the composer waits too.
		expect(replyBlocker('security_check', { agentEnabled: false, scanFinished: false })).toBe(
			'processing'
		);
		expect(replyBlocker('security_check', { agentEnabled: false })).toBe('processing');
		// With the agent on, the same state means it is still reading.
		expect(replyBlocker('security_check', { agentEnabled: true, scanFinished: true })).toBe(
			'processing'
		);
		// The scan has not run yet: never answer ahead of the quarantine check.
		expect(replyBlocker('received', { agentEnabled: false })).toBe('processing');
	});

	it('lets a person answer a rejected draft or an archived message', () => {
		expect(replyBlocker('rejected')).toBeNull();
		expect(replyBlocker('archived')).toBeNull();
		expect(needsTakeOver('rejected')).toBe(true);
	});

	it('opens the composer on a message the pipeline never picked up, after the server wait', () => {
		const receivedAt = 1_000_000;
		// The server's wait follows the follow-up window, so it can exceed 5 minutes.
		const waiting = { agentEnabled: true, pipelineStarted: false, receivedWaitMs: 11 * 60_000 };
		expect(replyBlocker('received', { ...waiting, receivedAt, now: receivedAt + 6 * 60_000 })).toBe(
			'processing'
		);
		expect(
			replyBlocker('received', { ...waiting, receivedAt, now: receivedAt + 11 * 60_000 })
		).toBeNull();
		// A pipeline run started and stalled: still the agent's.
		expect(
			replyBlocker('received', {
				...waiting,
				pipelineStarted: true,
				receivedAt,
				now: receivedAt + 60 * 60_000,
			})
		).toBe('processing');
	});

	it('lets a person write the reply instead of answering the agent', () => {
		expect(replyBlocker('awaiting_clarification')).toBeNull();
		expect(needsTakeOver('awaiting_clarification')).toBe(true);
	});

	it('takes the message over first unless it already waits on a person', () => {
		expect(needsTakeOver('draft_ready')).toBe(false);
		expect(needsTakeOver('failed')).toBe(true);
		expect(needsTakeOver('security_check')).toBe(true);
	});

	// #807: the takeover wins over the agent's unfinished draft.
	it('lets a person reply while the agent is still drafting, by taking it over', () => {
		expect(replyBlocker('drafting')).toBeNull();
		expect(needsTakeOver('drafting')).toBe(true);
		expect(replyNotice('drafting')).toBe('takesOverDraft');
	});

	// #807: an answered message takes a second message, not a takeover.
	it('sends a follow-up on an answered email message', () => {
		expect(replyBlocker('sent')).toBeNull();
		expect(isFollowUp('sent')).toBe(true);
		expect(needsTakeOver('sent')).toBe(false);
		expect(replyNotice('sent')).toBe('followUp');
		// A channel thread has no follow-up path yet.
		expect(replyBlocker('sent', { agentEnabled: true, isChannel: true })).toBe('answered');
	});

	it('tells channel messages from email ones by their `to`', () => {
		expect(isChannelMessage({ to: 'whatsapp' })).toBe(true);
		expect(isChannelMessage({ to: 'support@example.com' })).toBe(false);
		expect(isChannelMessage({})).toBe(false);
	});

	it('has no notice for a plain answer to a waiting message', () => {
		expect(replyNotice('draft_ready')).toBeNull();
		expect(replyNotice('failed')).toBeNull();
		for (const key of Object.values(REPLY_NOTICE_KEYS)) {
			expect(key).toMatch(/^dashboard\.inbox\.detail\.composer\.notice\./);
		}
	});

	it('names a reason for every other state, never an empty box that fails on send', () => {
		expect(replyBlocker('received')).toBe('processing');
		expect(replyBlocker('classifying')).toBe('processing');
		expect(replyBlocker('informational')).toBe('update');
		expect(replyBlocker('approved')).toBe('sending');
		expect(replyBlocker('quarantined')).toBe('quarantined');
		// An unknown future state reads as "still processing", not as sendable.
		expect(replyBlocker('something_new')).toBe('processing');
	});

	it('has copy for every blocker', () => {
		for (const key of Object.values(REPLY_BLOCKER_KEYS)) {
			expect(key).toMatch(/^dashboard\.inbox\.detail\.composer\.blocked\./);
		}
	});
});

describe('pickReplyTarget', () => {
	it('is null for an empty thread', () => {
		expect(pickReplyTarget([])).toBeNull();
		expect(pickReplyTarget(undefined)).toBeNull();
	});

	it('answers the newest message still waiting for a reply', () => {
		const older = msg('a', 1, 'draft_ready', 'Hi Ana');
		const newer = msg('b', 2, 'classifying');
		expect(pickReplyTarget([older, newer])?._id).toBe('a');
	});

	it('falls back to the newest message, whose state explains the wait', () => {
		const target = pickReplyTarget([
			msg('a', 1, 'sent'),
			msg('b', 3, 'failed'),
			msg('c', 2, 'sent'),
		]);
		expect(target?._id).toBe('b');
	});

	it('prefers the newest of several waiting messages', () => {
		const target = pickReplyTarget([msg('a', 1, 'draft_ready'), msg('b', 2, 'draft_ready')]);
		expect(target?._id).toBe('b');
	});
});

describe('hasAgentDraft', () => {
	it('ignores an empty or whitespace draft (a draftless escalation)', () => {
		expect(hasAgentDraft({ draftResponse: 'Thanks!' })).toBe(true);
		expect(hasAgentDraft({ draftResponse: '  ' })).toBe(false);
		expect(hasAgentDraft({})).toBe(false);
	});
});

describe('classification line', () => {
	it('keeps the category and only a priority worth a word', () => {
		expect(classificationSummary({ category: 'billing', priority: 'urgent' })).toEqual({
			category: 'billing',
			priority: 'urgent',
		});
		expect(classificationSummary({ category: 'support', priority: 'normal' })).toEqual({
			category: 'support',
			priority: null,
		});
		expect(classificationSummary(null)).toBeNull();
	});

	it('summarises the newest classified message', () => {
		const messages = [
			{ _creationTime: 1, classification: { category: 'sales', priority: 'low' } },
			{ _creationTime: 3 },
			{ _creationTime: 2, classification: { category: 'billing', priority: 'urgent' } },
		];
		expect(latestClassification(messages)?.category).toBe('billing');
		expect(latestClassification([{ _creationTime: 1 }])).toBeNull();
	});
});

describe('otherWaitingDrafts', () => {
	it('lists every other message with a waiting draft, oldest first', () => {
		const a = msg('a', 1, 'draft_ready');
		const b = msg('b', 2, 'sent');
		const c = msg('c', 3, 'draft_ready');
		const d = msg('d', 4, 'draft_ready');
		expect(otherWaitingDrafts([d, a, b, c], d).map((m) => m._id)).toEqual(['a', 'c']);
		expect(otherWaitingDrafts(undefined, null)).toEqual([]);
	});
});

describe('replySubject', () => {
	it('keeps the draft subject, else answers the message subject once', () => {
		expect(replySubject({ draftSubject: 'Re: Invoice', subject: 'Invoice' })).toBe('Re: Invoice');
		expect(replySubject({ subject: 'Invoice' })).toBe('Re: Invoice');
		expect(replySubject({ subject: 'RE: Invoice' })).toBe('RE: Invoice');
		expect(replySubject({})).toBe('');
	});
});
