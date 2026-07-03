/**
 * Default reply behavior (utils/postboxReplyDefault):
 *   - primary reply-kind derivation from the setting + whether reply-all adds
 *     anyone (reply-all collapses to a plain reply on a 1:1 message), and
 *   - in-place Reply → Reply-all conversion (recipients recomputed, self
 *     deduped, subject/body preserved).
 */
import { describe, it, expect } from 'vitest';
import {
	POSTBOX_REPLY_DEFAULT,
	resolvePrimaryReplyKind,
	convertReplyToReplyAll,
} from '../postboxReplyDefault';
import { deriveReplyAllExtras } from '../recipientHints';

describe('resolvePrimaryReplyKind', () => {
	it("defaults to plain reply", () => {
		expect(POSTBOX_REPLY_DEFAULT).toBe('reply');
	});

	it("stays a plain reply under the 'reply' preference, even with other recipients", () => {
		expect(resolvePrimaryReplyKind('reply', true)).toBe('reply');
		expect(resolvePrimaryReplyKind('reply', false)).toBe('reply');
	});

	it("opens reply-all under the 'reply-all' preference when it adds recipients", () => {
		expect(resolvePrimaryReplyKind('reply-all', true)).toBe('replyAll');
	});

	it("collapses reply-all to a plain reply on a 1:1 message (adds no one)", () => {
		expect(resolvePrimaryReplyKind('reply-all', false)).toBe('reply');
	});
});

describe('convertReplyToReplyAll', () => {
	// A reply draft to `sender@corp.com`; the original also went to a teammate
	// and cc'd the user's own address — reply-all must add the teammate but not
	// the user themselves.
	const original = {
		fromAddress: 'sender@corp.com',
		toAddresses: ['me@corp.com', 'teammate@corp.com'],
		ccAddresses: ['watcher@corp.com'],
	};
	const self = ['me@corp.com'];

	function replyDraft() {
		return {
			to: ['sender@corp.com'],
			cc: [] as string[],
			subject: 'Re: Roadmap',
			bodyHtml: '<p>Sounds good.</p><blockquote>original</blockquote>',
		};
	}

	it('recomputes Cc from the reply-all extras, excluding the sender and self', () => {
		const extras = deriveReplyAllExtras(original, self);
		// deriveReplyAllExtras already drops the sender + the user's own address.
		expect(extras).toEqual(['teammate@corp.com', 'watcher@corp.com']);

		const converted = convertReplyToReplyAll(replyDraft(), extras);
		expect(converted.cc).toEqual(['teammate@corp.com', 'watcher@corp.com']);
		expect(converted.cc).not.toContain('me@corp.com');
		expect(converted.cc).not.toContain('sender@corp.com');
	});

	it('preserves To, subject and body verbatim (converts in place)', () => {
		const extras = deriveReplyAllExtras(original, self);
		const draft = replyDraft();
		const converted = convertReplyToReplyAll(draft, extras);
		expect(converted.to).toEqual(['sender@corp.com']);
		expect(converted.subject).toBe('Re: Roadmap');
		expect(converted.bodyHtml).toBe(draft.bodyHtml);
	});

	it('does not double an extra already present in Cc, and keeps the To sender out of Cc', () => {
		const draft = { ...replyDraft(), cc: ['teammate@corp.com'] };
		const extras = deriveReplyAllExtras(original, self);
		const converted = convertReplyToReplyAll(draft, extras);
		// teammate stays once; watcher is appended; sender never enters Cc.
		expect(converted.cc).toEqual(['teammate@corp.com', 'watcher@corp.com']);
	});
});
