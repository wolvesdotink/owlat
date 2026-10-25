/**
 * The personal-mail dispatch's pure decisions (`mail/outbound/decision.ts`)
 * for fixed drafts and lifecycle answers. `outboundDispatchGuards.test.ts`
 * and `plaintextSendConsent.test.ts` hold the live action to them.
 */
import { describe, expect, it } from 'vitest';
import type { Id } from '../../_generated/dataModel';
import {
	decideAfterSent,
	decideDispatchStart,
	dispatchRecipients,
	isUnsealedConsentMissing,
	sendingMailboxId,
	sentContext,
} from '../outbound/decision';

const DRAFT_ID = 'draft_1' as Id<'mailDrafts'>;
const THREAD_MAILBOX = 'mailbox_thread' as Id<'mailboxes'>;
const PERSONAL_MAILBOX = 'mailbox_personal' as Id<'mailboxes'>;
const RAW = 'storage_1' as Id<'_storage'>;
const MESSAGE = 'message_1' as Id<'mailMessages'>;

describe('decideDispatchStart', () => {
	it('builds a pending or scheduled draft whose token matches', () => {
		const pending = { state: 'pending_send' as const, undoToken: 'tok' };
		expect(decideDispatchStart(DRAFT_ID, pending, 'tok')).toEqual({
			kind: 'build',
			draft: pending,
		});
		const scheduled = { state: 'scheduled' as const, undoToken: 'tok' };
		expect(decideDispatchStart(DRAFT_ID, scheduled, 'tok').kind).toBe('build');
	});

	it('skips a missing draft, a draft no longer pending and a stale hop, in that order', () => {
		const reason = (draft: Parameters<typeof decideDispatchStart>[1], token = 'tok') => {
			const start = decideDispatchStart(DRAFT_ID, draft, token);
			return start.kind === 'skip' ? start.log.message : 'build';
		};
		expect(reason(null)).toBe('[Outbound] Draft draft_1 not found; skipping');
		expect(reason({ state: 'draft', undoToken: 'other' })).toBe(
			'[Outbound] Draft draft_1 no longer in pending_send; skipping'
		);
		expect(reason({ state: 'pending_send', undoToken: 'tok' }, 'older')).toBe(
			'[Outbound] Draft draft_1 undoToken mismatch; skipping'
		);
	});
});

describe('isUnsealedConsentMissing', () => {
	const unsealed = (reason: 'no_signing_key' | 'key_changed' | 'recipient_no_key') => ({
		isSealed: false as const,
		reason,
	});

	it('asks only for a send that could have been sealed, without consent', () => {
		expect(
			isUnsealedConsentMissing({
				isFlagEnabled: true,
				encryptionInfo: unsealed('no_signing_key'),
				isUnsealedSendAllowed: undefined,
			})
		).toBe(true);
		expect(
			isUnsealedConsentMissing({
				isFlagEnabled: true,
				encryptionInfo: unsealed('key_changed'),
				isUnsealedSendAllowed: true,
			})
		).toBe(false);
		expect(
			isUnsealedConsentMissing({
				isFlagEnabled: true,
				encryptionInfo: unsealed('recipient_no_key'),
				isUnsealedSendAllowed: undefined,
			})
		).toBe(false);
		expect(
			isUnsealedConsentMissing({
				isFlagEnabled: false,
				encryptionInfo: unsealed('no_signing_key'),
				isUnsealedSendAllowed: undefined,
			})
		).toBe(false);
	});
});

describe('sentContext', () => {
	const draft = {
		bodyHtml: '<p>Hi</p>',
		bodyText: 'Hi',
		attachments: [
			{ filename: 'a.pdf', contentType: 'application/pdf', size: 3, contentId: undefined },
			{ filename: 'b.png', contentType: 'image/png', size: 4, contentId: 'cid-b' },
		],
	} as Parameters<typeof sentContext>[0]['draft'];

	it('records the stored copy, unbracketed message ids and the attachment parts', () => {
		const context = sentContext({
			draft,
			rawStorageId: RAW,
			storedSize: 1234,
			isFlagEnabled: false,
			encryptionInfo: { isSealed: false, reason: 'flag_off' },
			rfc822MessageId: '<m1@a.test>',
			inReplyToHeaderValue: '<p1@a.test>',
			referencesHeaderValue: '<r1@a.test> <r2@a.test>',
		});
		expect(context).toEqual({
			rawStorageId: RAW,
			rawSize: 1234,
			rfc822MessageId: 'm1@a.test',
			inReplyToHeaderValue: 'p1@a.test',
			references: ['r1@a.test', 'r2@a.test'],
			bodyHtml: '<p>Hi</p>',
			bodyText: 'Hi',
			attachmentsMeta: [
				{
					filename: 'a.pdf',
					contentType: 'application/pdf',
					size: 3,
					contentId: undefined,
					partIndex: '0',
				},
				{
					filename: 'b.png',
					contentType: 'image/png',
					size: 4,
					contentId: 'cid-b',
					partIndex: '1',
				},
			],
		});
		expect('encryptionInfo' in context).toBe(false);
	});

	it('stamps the encryption info only while Sealed Mail is on', () => {
		const encryptionInfo = { isSealed: false as const, reason: 'recipient_no_key' as const };
		const context = sentContext({
			draft,
			rawStorageId: RAW,
			storedSize: 1,
			isFlagEnabled: true,
			encryptionInfo,
			rfc822MessageId: '<m1@a.test>',
			inReplyToHeaderValue: undefined,
			referencesHeaderValue: undefined,
		});
		expect(context.encryptionInfo).toEqual(encryptionInfo);
		expect(context.references).toEqual([]);
		expect(context.inReplyToHeaderValue).toBeUndefined();
	});
});

describe('decideAfterSent', () => {
	const draft = {
		fromAddress: 'pat@a.test',
		mailboxId: THREAD_MAILBOX,
		sendAsMailboxId: PERSONAL_MAILBOX,
	};

	it('hands a sent row to the transport', () => {
		expect(
			decideAfterSent(DRAFT_ID, draft, {
				ok: true,
				applied: 'transitioned',
				draftId: DRAFT_ID,
				from: 'pending_send',
				to: 'sent',
				messageId: MESSAGE,
			})
		).toEqual({ kind: 'transport', mailMessageId: MESSAGE });
	});

	it('drops the stored copy and leaves the draft alone when the send was withdrawn', () => {
		expect(decideAfterSent(DRAFT_ID, draft, { ok: false, reason: 'undo_token_mismatch' })).toEqual({
			kind: 'stop',
			log: {
				level: 'info',
				message: '[Outbound] Draft draft_1 undoToken changed during dispatch; skipping',
			},
			isRawDeleted: true,
		});
	});

	it('reverts a revoked From, naming the sending mailbox', () => {
		const plan = decideAfterSent(DRAFT_ID, draft, { ok: false, reason: 'from_revoked' });
		expect(plan).toMatchObject({ kind: 'stop', isRawDeleted: true, revert: 'from_revoked' });
		expect(plan.kind === 'stop' && plan.log.message).toContain(
			'sending mailbox mailbox_personal (thread mailbox mailbox_thread)'
		);
	});

	it('drops the stored copy on any other refusal, and keeps it when the row has no id', () => {
		expect(
			decideAfterSent(DRAFT_ID, draft, { ok: false, reason: 'sent_folder_missing' })
		).toMatchObject({
			kind: 'stop',
			isRawDeleted: true,
		});
		const noId = decideAfterSent(DRAFT_ID, draft, {
			ok: true,
			applied: 'transitioned',
			draftId: DRAFT_ID,
			from: 'pending_send',
			to: 'sent',
		});
		expect(noId).toMatchObject({ kind: 'stop', isRawDeleted: false });
		expect(noId.kind === 'stop' && noId.revert).toBeFalsy();
	});
});

describe('recipients and the sending mailbox', () => {
	it('lists every recipient once, To first', () => {
		expect(
			dispatchRecipients({
				toAddresses: ['a@x.test', 'b@x.test'],
				ccAddresses: ['b@x.test', 'c@x.test'],
				bccAddresses: ['a@x.test', 'd@x.test'],
			})
		).toEqual(['a@x.test', 'b@x.test', 'c@x.test', 'd@x.test']);
	});

	it('sends through the send-as mailbox when one is chosen', () => {
		expect(sendingMailboxId({ mailboxId: THREAD_MAILBOX, sendAsMailboxId: PERSONAL_MAILBOX })).toBe(
			PERSONAL_MAILBOX
		);
		expect(sendingMailboxId({ mailboxId: THREAD_MAILBOX })).toBe(THREAD_MAILBOX);
	});
});
