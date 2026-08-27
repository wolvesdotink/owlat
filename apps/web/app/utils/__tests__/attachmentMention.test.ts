/**
 * The forgot-attachment guard (utils/attachmentMention).
 *
 * The blind spots this suite pins are the ones that made the single-regex
 * version untrustworthy: "attached to the project", the quoted original of a
 * reply, a German draft, and a promise to attach something later.
 */
import { describe, it, expect } from 'vitest';
import { detectMissingAttachment } from '../attachmentMention';

const draft = (over: Partial<Parameters<typeof detectMissingAttachment>[0]>) =>
	detectMissingAttachment({
		subject: '',
		bodyHtml: '',
		hasAttachments: false,
		...over,
	});

describe('detectMissingAttachment — the direct claim', () => {
	it('fires on attach/enclose wording in the subject or the body', () => {
		expect(draft({ subject: 'See attached' })).toEqual({ kind: 'mention', phrase: 'attached' });
		expect(draft({ bodyHtml: '<p>the file is enclosed below</p>' })?.kind).toBe('mention');
		expect(draft({ bodyHtml: '<p>I am attaching the report</p>' })?.kind).toBe('mention');
	});

	it('stays silent once the draft actually has an attachment', () => {
		expect(draft({ subject: 'See attached', hasAttachments: true })).toBeNull();
	});

	it('strips tags before matching, so a tag name never counts', () => {
		expect(draft({ bodyHtml: '<p>please find it attached</p>' })?.kind).toBe('mention');
		expect(draft({ bodyHtml: '<attachment>x</attachment>' })).toBeNull();
	});

	it('says nothing about unrelated copy', () => {
		expect(draft({ subject: 'Weekly sync', bodyHtml: '<p>Notes from today.</p>' })).toBeNull();
	});
});

describe('detectMissingAttachment — negative context', () => {
	it('ignores "attached to" something that is not this message', () => {
		expect(draft({ bodyHtml: '<p>The ticket is attached to the project board.</p>' })).toBeNull();
		expect(draft({ bodyHtml: '<p>I attached it to the ticket last week.</p>' })).toBeNull();
	});

	it('keeps "attached to this email" — that one is a real claim', () => {
		expect(draft({ bodyHtml: '<p>The invoice is attached to this email.</p>' })?.kind).toBe(
			'mention'
		);
	});

	it('ignores an explicit absence', () => {
		expect(draft({ bodyHtml: '<p>No attachment this time, the text is below.</p>' })).toBeNull();
		expect(draft({ bodyHtml: '<p>Sending this without any attachments.</p>' })).toBeNull();
	});

	it('ignores a promise to attach something later', () => {
		expect(draft({ bodyHtml: "<p>I'll attach the signed copy tomorrow.</p>" })).toBeNull();
		expect(draft({ bodyHtml: '<p>We will attach the report once it is final.</p>' })).toBeNull();
	});
});

describe('detectMissingAttachment — indirect "see the deck" phrasing', () => {
	it('fires when the sentence names a document', () => {
		expect(draft({ bodyHtml: '<p>Have a look at the deck before Friday.</p>' })?.kind).toBe(
			'mention'
		);
		expect(draft({ bodyHtml: '<p>See the spreadsheet for the Q3 split.</p>' })?.kind).toBe(
			'mention'
		);
		expect(draft({ bodyHtml: '<p>Check out the PDF, page 4.</p>' })?.kind).toBe('mention');
	});

	it('does not fire when the document is said to be somewhere else', () => {
		expect(draft({ bodyHtml: '<p>See the deck on our website.</p>' })).toBeNull();
		expect(draft({ bodyHtml: '<p>See the report linked below.</p>' })).toBeNull();
	});

	it('does not fire on a sentence that names no document at all', () => {
		expect(draft({ bodyHtml: '<p>Check out our pricing page when you can.</p>' })).toBeNull();
	});
});

describe('detectMissingAttachment — German', () => {
	const de = (bodyHtml: string) => draft({ bodyHtml, locale: 'de-DE' });

	it('fires on the German claims the old English regex never saw', () => {
		expect(de('<p>Anbei die Rechnung.</p>')).toEqual({ kind: 'mention', phrase: 'Anbei' });
		expect(de('<p>Die Unterlagen sind beigefügt.</p>')?.kind).toBe('mention');
		expect(de('<p>Details im Anhang.</p>')?.kind).toBe('mention');
		expect(de('<p>Siehe das angehängte Dokument.</p>')?.kind).toBe('mention');
	});

	it('respects German negative context', () => {
		expect(de('<p>Diesmal ohne Anhang, alles steht unten.</p>')).toBeNull();
		expect(de('<p>Ich werde die Rechnung morgen anhängen.</p>')).toBeNull();
	});

	it('still catches an English draft written in a German UI', () => {
		expect(de('<p>See attached.</p>')?.kind).toBe('mention');
	});

	it('leaves German alone for an English UI rather than guessing', () => {
		expect(draft({ bodyHtml: '<p>Anbei die Rechnung.</p>', locale: 'en' })).toBeNull();
	});
});

describe('detectMissingAttachment — the quoted chain', () => {
	const QUOTED_CLAIM =
		'<p>Thanks, will read it.</p><blockquote><p>Hi, see attached.</p></blockquote>';

	it('never accuses a reply of the original sender’s "see attached"', () => {
		expect(draft({ subject: 'Re: contract', bodyHtml: QUOTED_CLAIM })).toBeNull();
	});

	it('flags a forward whose quoted body references an attachment that is gone', () => {
		expect(draft({ subject: 'Fwd: contract', bodyHtml: QUOTED_CLAIM })).toEqual({
			kind: 'forwardedQuote',
			phrase: 'attached',
		});
	});

	it('recognises the forward by its separator when the subject was rewritten', () => {
		expect(
			draft({
				subject: 'contract for you',
				bodyHtml:
					'<p>FYI</p><blockquote><p>---------- Forwarded message ----------</p>' +
					'<p>Please find the invoice attached.</p></blockquote>',
			})?.kind
		).toBe('forwardedQuote');
	});

	it('says nothing about a forward whose original mentioned no attachment', () => {
		expect(
			draft({
				subject: 'Fwd: sync notes',
				bodyHtml: '<p>FYI</p><blockquote><p>Notes from today.</p></blockquote>',
			})
		).toBeNull();
	});

	it('prefers the sender’s own claim over the quoted one', () => {
		expect(
			draft({
				subject: 'Fwd: contract',
				bodyHtml: '<p>Enclosing the signed copy.</p><blockquote><p>see attached</p></blockquote>',
			})
		).toEqual({ kind: 'mention', phrase: 'Enclosing' });
	});
});
