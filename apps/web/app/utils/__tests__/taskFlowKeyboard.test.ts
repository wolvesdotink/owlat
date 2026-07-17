/**
 * The focused-flow keyboard resolvers gate the ambient card vocabulary to the
 * BUILT-IN kinds a flow renders natively: on a plugin/unknown card the native
 * shortcuts must be inert (only the shared `s` → skip survives), so pressing
 * Enter over the graceful placeholder can never fire a hidden send/reject/
 * archive on the underlying item. Built-in behaviour must stay byte-identical.
 */
import { describe, it, expect } from 'vitest';
import { resolveReviewFocusKey, resolveReplyFocusKey } from '../taskFlowKeyboard';

describe('resolveReviewFocusKey', () => {
	it('maps the built-in Review vocabulary (draft-review card)', () => {
		const ctx = { currentKind: 'draft_review' as const, needsReply: false };
		expect(resolveReviewFocusKey('x', ctx)).toBe('reject');
		expect(resolveReviewFocusKey('a', ctx)).toBe('approve');
		expect(resolveReviewFocusKey('Enter', ctx)).toBe('approve');
	});

	it('maps the built-in Review vocabulary (needs-reply escalation)', () => {
		const ctx = { currentKind: 'reply' as const, needsReply: true };
		expect(resolveReviewFocusKey('x', ctx)).toBe('reject');
		// `a` (approve) is not offered on an escalation with no draft.
		expect(resolveReviewFocusKey('a', ctx)).toBeNull();
		expect(resolveReviewFocusKey('Enter', ctx)).toBe('sendReply');
	});

	it('inerts the native vocabulary on a non-built-in card and only skips on `s`', () => {
		const ctx = { currentKind: 'plugin.acme.survey' as const, needsReply: false };
		expect(resolveReviewFocusKey('Enter', ctx)).toBeNull();
		expect(resolveReviewFocusKey('a', ctx)).toBeNull();
		expect(resolveReviewFocusKey('x', ctx)).toBeNull();
		expect(resolveReviewFocusKey('e', ctx)).toBeNull();
		expect(resolveReviewFocusKey('s', ctx)).toBe('skip');
	});

	it('does nothing without a current kind', () => {
		expect(resolveReviewFocusKey('Enter', { currentKind: null, needsReply: false })).toBeNull();
		expect(resolveReviewFocusKey('s', { currentKind: null, needsReply: false })).toBeNull();
	});
});

describe('resolveReplyFocusKey', () => {
	it('maps the built-in Reply vocabulary (needs-you row)', () => {
		const ctx = { currentKind: 'reply' as const, isFollowup: false };
		expect(resolveReplyFocusKey('Enter', ctx)).toBe('draftReply');
		expect(resolveReplyFocusKey('e', ctx)).toBe('archive');
	});

	it('maps the built-in Reply vocabulary (follow-up row)', () => {
		const ctx = { currentKind: 'reply' as const, isFollowup: true };
		expect(resolveReplyFocusKey('Enter', ctx)).toBe('markDone');
		// Archive is not offered on a follow-up (we are waiting on them).
		expect(resolveReplyFocusKey('e', ctx)).toBeNull();
	});

	it('inerts the native vocabulary on a non-built-in card and only skips on `s`', () => {
		const ctx = { currentKind: 'plugin.acme.survey' as const, isFollowup: false };
		expect(resolveReplyFocusKey('Enter', ctx)).toBeNull();
		expect(resolveReplyFocusKey('e', ctx)).toBeNull();
		expect(resolveReplyFocusKey('a', ctx)).toBeNull();
		expect(resolveReplyFocusKey('x', ctx)).toBeNull();
		expect(resolveReplyFocusKey('s', ctx)).toBe('skip');
	});

	it('does nothing without a current kind', () => {
		expect(resolveReplyFocusKey('Enter', { currentKind: null, isFollowup: false })).toBeNull();
		expect(resolveReplyFocusKey('s', { currentKind: null, isFollowup: false })).toBeNull();
	});
});
