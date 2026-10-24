/**
 * The IMAP server's frozen wire fixtures: one recorded answer per outcome of
 * every function in `IMAP_ENDPOINTS`, against one seeded mailbox.
 *
 * The mailbox: INBOX holds message 1 (read, flagged, with an attachment and
 * every optional header) and message 2 (unread, marked `\Deleted`); Sent is
 * empty; Receipts is an unsubscribed child of INBOX. apps/api's
 * `workerWire*.test.ts` seeds exactly this and records each answer.
 */

import { IMAP_WIRE_MIN_SUPPORTED, IMAP_WIRE_VERSION } from '@owlat/shared/imapWire';
import type { IMAP_ENDPOINTS } from '../imap/index';
import { wirePlaceholder as id, type WireFixtures } from './types';

export const IMAP_WIRE_IDS = {
	mailbox: id('mailboxes/fixture'),
	appPassword: id('mailAppPasswords/fixture'),
	inbox: id('mailFolders/inbox'),
	sent: id('mailFolders/sent'),
	receipts: id('mailFolders/receipts'),
	goneFolder: id('mailFolders/gone'),
	message1: id('mailMessages/1'),
	message2: id('mailMessages/2'),
	goneMessage: id('mailMessages/gone'),
	appended: id('mailMessages/appended'),
	rawUrl: id('url/raw/1'),
	uploadUrl: id('url/upload'),
	changedCursor: id('cursor/changed'),
	inboxMembership: id('membership/inbox'),
	receiptsMembership: id('membership/receipts'),
} as const;

const I = IMAP_WIRE_IDS;

export const IMAP_FIXTURE_FOLDERS = {
	inbox: {
		_id: I.inbox,
		name: 'INBOX',
		role: 'inbox',
		uidValidity: 1_700_000_000,
		uidNext: 3,
		highestModseq: 5,
		totalCount: 2,
		unseenCount: 1,
	},
	sent: {
		_id: I.sent,
		name: 'Sent',
		role: 'sent',
		uidValidity: 1_700_000_001,
		uidNext: 1,
		highestModseq: 1,
		totalCount: 0,
		unseenCount: 0,
	},
	receipts: {
		_id: I.receipts,
		name: 'Receipts',
		uidValidity: 1_700_000_002,
		uidNext: 1,
		highestModseq: 1,
		totalCount: 0,
		unseenCount: 0,
	},
} as const;

/** Message 1 as FETCH reads it: every optional field present. */
export const IMAP_FIXTURE_ENVELOPE_1 = {
	_id: I.message1,
	uid: 1,
	modseq: 4,
	rawSize: 2048,
	rfc822MessageId: 'quarterly-1@example.com',
	inReplyTo: 'kickoff@example.com',
	references: ['kickoff@example.com'],
	fromAddress: 'ada@example.com',
	fromName: 'Ada Lovelace',
	toAddresses: ['fixture@owlat.example'],
	ccAddresses: ['grace@example.com'],
	bccAddresses: [],
	replyToAddress: 'replies@example.com',
	subject: 'Quarterly numbers',
	internalDate: 1_749_990_000_000,
	attachments: [
		{
			filename: 'numbers.pdf',
			contentType: 'application/pdf',
			size: 1024,
			contentId: 'numbers@example.com',
			partIndex: '2',
		},
	],
	hasAttachments: true,
	flagSeen: true,
	flagFlagged: true,
	flagAnswered: false,
	flagDraft: false,
	flagDeleted: false,
	customFlags: ['$Label1'],
};

/** Message 2: no optional field present. */
export const IMAP_FIXTURE_ENVELOPE_2 = {
	_id: I.message2,
	uid: 2,
	modseq: 5,
	rawSize: 512,
	rfc822MessageId: 'reminder-2@example.com',
	fromAddress: 'billing@example.com',
	toAddresses: ['fixture@owlat.example'],
	ccAddresses: [],
	bccAddresses: [],
	subject: 'Invoice reminder',
	internalDate: 1_749_995_000_000,
	attachments: [],
	hasAttachments: false,
	flagSeen: false,
	flagFlagged: false,
	flagAnswered: false,
	flagDraft: false,
	flagDeleted: true,
	customFlags: [],
};

const F = IMAP_FIXTURE_FOLDERS;

export const IMAP_WIRE_FIXTURES = {
	verifyAppPassword: [
		{
			name: 'verified',
			value: {
				mailboxId: I.mailbox,
				appPasswordId: I.appPassword,
				userId: 'user-fixture',
				organizationId: 'org-fixture',
			},
		},
		{ name: 'refused', value: null },
	],
	touchAppPassword: [{ name: 'recorded', value: null }],
	reportServer: [
		{
			name: 'current',
			value: {
				backendWireVersion: IMAP_WIRE_VERSION,
				minSupportedWireVersion: IMAP_WIRE_MIN_SUPPORTED,
				compatible: true,
			},
		},
		{
			name: 'server too old',
			value: {
				backendWireVersion: IMAP_WIRE_VERSION,
				minSupportedWireVersion: IMAP_WIRE_MIN_SUPPORTED,
				compatible: false,
				reason: 'server_too_old',
			},
		},
		{
			name: 'backend older',
			value: {
				backendWireVersion: IMAP_WIRE_VERSION,
				minSupportedWireVersion: IMAP_WIRE_MIN_SUPPORTED,
				compatible: false,
				reason: 'backend_older',
			},
		},
	],
	listFolders: [
		{
			name: 'system and user folders',
			value: [
				{ ...F.inbox, subscribed: true },
				{ ...F.sent, subscribed: true },
				{ ...F.receipts, parentId: I.inbox, subscribed: false },
			],
		},
	],
	selectFolder: [
		{ name: 'with an unseen message', value: { folder: F.inbox, firstUnseenUid: 2 } },
		{ name: 'all seen', value: { folder: F.sent } },
		{ name: 'gone', value: null },
	],
	fetchEnvelopes: [
		{
			name: 'whole window',
			value: { rows: [IMAP_FIXTURE_ENVELOPE_1, IMAP_FIXTURE_ENVELOPE_2], nextUid: null },
		},
		{ name: 'full page', value: { rows: [IMAP_FIXTURE_ENVELOPE_1], nextUid: 2 } },
	],
	fetchChangedEnvelopes: [
		{
			name: 'one changed row',
			// The handler spreads Convex's own pagination result, split fields included.
			value: {
				page: [IMAP_FIXTURE_ENVELOPE_2],
				isDone: true,
				continueCursor: I.changedCursor,
				splitCursor: null,
				pageStatus: null,
			},
		},
	],
	listFolderUidsPage: [
		{ name: 'whole folder', value: { uids: [1, 2], nextUid: null } },
		{ name: 'full page', value: { uids: [1], nextUid: 2 } },
	],
	folderMembershipPage: [
		{ name: 'not maintained', value: null },
		{ name: 'still building', value: { version: I.receiptsMembership, isReady: false } },
		{
			name: 'blocks',
			value: { version: I.inboxMembership, isReady: true, blocks: [[1, 2]], nextFirstUid: null },
		},
		{ name: 'unchanged', value: { version: I.inboxMembership, isReady: true, unchanged: true } },
	],
	peekFolderModseq: [
		{
			name: 'counters',
			value: { highestModseq: 5, uidNext: 3, totalCount: 2, unseenCount: 1 },
		},
		{ name: 'gone', value: null },
	],
	resolveSpecialFolder: [
		{ name: 'found', value: { _id: I.sent, name: 'Sent' } },
		{ name: 'none', value: null },
	],
	storeFlags: [
		{
			name: 'one updated, one changed since',
			value: {
				updated: [
					{ messageId: I.message1, uid: 1, modseq: 6, flags: ['\\Seen', '\\Flagged', '$Label1'] },
				],
				unchanged: [{ messageId: I.message2, uid: 2 }],
			},
		},
	],
	copyMessages: [
		{
			name: 'copied',
			value: { uidValidity: 1_700_000_002, pairs: [{ sourceUid: 1, targetUid: 1 }] },
		},
	],
	moveMessages: [
		{
			name: 'moved',
			value: { uidValidity: 1_700_000_002, pairs: [{ sourceUid: 1, targetUid: 1 }] },
		},
	],
	expungeFolder: [
		{ name: 'one page', value: { uids: [2], modseq: 6, done: true, beforeUid: 1 } },
		{ name: 'folder gone', value: { uids: [], modseq: 0, done: true } },
	],
	discardCopies: [{ name: 'removed', value: { removed: 1 } }],
	appendMessage: [
		{
			name: 'appended',
			value: { messageId: I.appended, uid: 1, uidValidity: 1_700_000_001, modseq: 2 },
		},
	],
	resolveMessageIdsByUid: [
		{
			name: 'whole window',
			value: {
				rows: [
					{ _id: I.message1, uid: 1, modseq: 4 },
					{ _id: I.message2, uid: 2, modseq: 5 },
				],
				nextUid: null,
			},
		},
	],
	getRawStorageUrls: [
		{
			name: 'one stored, one gone',
			value: [
				{ messageId: I.message1, url: I.rawUrl },
				{ messageId: I.goneMessage, url: null },
			],
		},
	],
	generateUploadUrl: [{ name: 'minted', value: I.uploadUrl }],
} satisfies WireFixtures<typeof IMAP_ENDPOINTS>;
