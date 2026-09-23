import { describe, expect, it } from 'vitest';
import {
	REPLY_BLOCKER_KEYS,
	classificationSummary,
	hasAgentDraft,
	latestClassification,
	needsTakeOver,
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
		expect(replyBlocker('security_check', { agentEnabled: false })).toBeNull();
		// With the agent on, the same state means it is still reading.
		expect(replyBlocker('security_check', { agentEnabled: true })).toBe('processing');
		// The scan has not run yet: never answer ahead of the quarantine check.
		expect(replyBlocker('received', { agentEnabled: false })).toBe('processing');
	});

	it('takes the message over first unless it already waits on a person', () => {
		expect(needsTakeOver('draft_ready')).toBe(false);
		expect(needsTakeOver('failed')).toBe(true);
		expect(needsTakeOver('security_check')).toBe(true);
	});

	it('names a reason for every other state, never an empty box that fails on send', () => {
		expect(replyBlocker('received')).toBe('processing');
		expect(replyBlocker('classifying')).toBe('processing');
		// Approving mid-draft would race the agent's own draft_ready.
		expect(replyBlocker('drafting')).toBe('drafting');
		expect(replyBlocker('awaiting_clarification')).toBe('needsInput');
		expect(replyBlocker('informational')).toBe('update');
		expect(replyBlocker('approved')).toBe('sending');
		expect(replyBlocker('sent')).toBe('answered');
		expect(replyBlocker('rejected')).toBe('closed');
		expect(replyBlocker('archived')).toBe('closed');
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
