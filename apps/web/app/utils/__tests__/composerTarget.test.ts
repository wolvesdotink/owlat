/**
 * The composer-target seam (#812): what each destination lets a composer do,
 * and the pre-send checks that apply to it.
 */
import { describe, expect, it } from 'vitest';
import {
	composerPreflight,
	composerTargetCapabilities,
	mailboxComposerTarget,
	type ComposerTarget,
} from '../composerTarget';

const mailbox: ComposerTarget = { kind: 'mailbox', mailboxId: 'mb_1' as never };
const teamThread: ComposerTarget = {
	kind: 'teamThread',
	threadId: 'th_1' as never,
	inboundMessageId: 'in_1' as never,
};

const ids = (target: ComposerTarget, draft: { subject: string; body: string }) =>
	composerPreflight(target, draft).map((finding) => finding.id);

describe('composerTargetCapabilities', () => {
	it('gives a mailbox the full Postbox composer', () => {
		expect(composerTargetCapabilities(mailbox)).toEqual({
			body: 'html',
			persistence: 'autosave',
			envelope: true,
			sendAs: true,
			signatures: true,
			attachments: 'draft',
			schedule: true,
			replyReminder: true,
			seal: true,
			recipientGuards: true,
			preflight: true,
			subjectFallback: false,
			agentDraft: false,
		});
	});

	it('keeps a team reply to what its send path carries: plain text to the sender', () => {
		expect(composerTargetCapabilities(teamThread)).toEqual({
			body: 'text',
			persistence: 'explicit',
			envelope: false,
			sendAs: false,
			signatures: false,
			// Files live on the thread (`inbox.replyAttachments`), through the
			// host's panel; the composer uploads none of its own.
			attachments: 'thread',
			schedule: false,
			replyReminder: false,
			seal: false,
			recipientGuards: false,
			preflight: true,
			subjectFallback: true,
			agentDraft: true,
		});
	});
});

describe('mailboxComposerTarget', () => {
	it('names the mailbox target a composer seed opens on, and nothing else of the seed', () => {
		expect(
			mailboxComposerTarget({
				mailboxId: 'mb_1' as never,
				draftId: 'dr_1' as never,
				inReplyToMessageId: 'mm_1' as never,
				prefillSubject: 'Re: Invoice',
			} as never)
		).toEqual({
			kind: 'mailbox',
			mailboxId: 'mb_1',
			draftId: 'dr_1',
			inReplyToMessageId: 'mm_1',
		});
	});
});

describe('composerPreflight', () => {
	it('flags a leftover marker or variable in a plain-text team reply', () => {
		expect(
			ids(teamThread, {
				subject: 'Re: Invoice 4471',
				body: 'Hi {{firstName}},\n\nThe refund is queued [TODO: add date].',
			})
		).toEqual(['placeholder', 'unfilledVariable']);
	});

	it('does not ask for a subject the server fills in for a team reply', () => {
		expect(ids(teamThread, { subject: '', body: 'Thanks, all sorted.' })).toEqual([]);
		expect(ids(mailbox, { subject: '', body: '<p>Thanks, all sorted.</p>' })).toEqual([
			'emptySubject',
		]);
	});

	it('reads a plain-text body as text, never as markup', () => {
		// Typed angle brackets are escaped on the way out, so no link exists to
		// disagree with its text.
		expect(
			ids(teamThread, {
				subject: 'Re: login',
				body: '<a href="https://evil.example">https://owlat.example</a>',
			})
		).toEqual([]);
		expect(
			ids(mailbox, {
				subject: 'Re: login',
				body: '<a href="https://evil.example">https://owlat.example</a>',
			})
		).toEqual(['linkMismatch']);
	});

	it('finds nothing in a finished reply', () => {
		expect(ids(teamThread, { subject: 'Re: Invoice', body: 'The refund landed today.' })).toEqual(
			[]
		);
	});
});
