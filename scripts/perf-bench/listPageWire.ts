/**
 * The shape check for a Postbox list page after its JSON round trip (the
 * fixture's `wireCopy`). The round trip is what the Convex client does to every
 * update, so the copy keeps JSON semantics (undefined properties dropped, fresh
 * nested objects); this checks that what came back is still a list page before
 * the benchmark and the contract tests treat it as one. postboxListPage.ts holds
 * the declared row type and checks this decoder against it at compile time.
 */
import {
	arrayOf,
	boolean,
	literal,
	nullable,
	number,
	object,
	oneOf,
	optional,
	string,
} from '../json';

const localized = object({ en: string, de: string });

const briefTop = object({
	mode: literal('brief', 'actions'),
	forYou: number,
	waiting: number,
	top: optional(
		object({
			itemId: string,
			bucket: optional(literal('forUs', 'waitingOnOthers')),
			responsibility: literal('us', 'them', 'unclear'),
			text: localized,
			dueAt: optional(number),
		})
	),
	latest: optional(localized),
	gist: optional(object({ text: string, factQuote: optional(string) })),
	isReplyNeeded: boolean,
});

const decrypted = object({
	isSealed: literal(true),
	isDecrypted: literal(true),
	cipherSuite: string,
	isSignatureValid: boolean,
	signerFingerprint: optional(string),
	signerInstance: optional(string),
});
const undecrypted = object({ isSealed: literal(true), isDecrypted: literal(false) });

const listRow = object({
	_id: string,
	_creationTime: number,
	mailboxId: string,
	folderId: string,
	threadId: string,
	fromAddress: string,
	fromName: optional(string),
	toAddresses: arrayOf(string),
	ccAddresses: arrayOf(string),
	replyToAddress: optional(string),
	subject: string,
	snippet: string,
	attachments: arrayOf(
		object({
			filename: string,
			contentType: string,
			size: number,
			contentId: optional(string),
			partIndex: string,
		})
	),
	hasAttachments: boolean,
	attachmentIndexing: optional(string),
	flagSeen: boolean,
	flagFlagged: boolean,
	flagAnswered: boolean,
	flagDraft: boolean,
	labelIds: arrayOf(string),
	trashedAt: optional(number),
	snoozedUntil: optional(number),
	isSnoozeUntilReply: optional(boolean),
	pinnedSection: optional(string),
	unsubscribe: optional(
		object({ httpUrl: optional(string), mailtoUrl: optional(string), oneClick: boolean })
	),
	receivedAt: number,
	spamVerdict: optional(string),
	virusVerdict: optional(string),
	spfResult: optional(string),
	dkimResult: optional(string),
	dmarcResult: optional(string),
	dmarcPolicy: optional(string),
	envelopeFromDomain: optional(string),
	dkimSigningDomain: optional(string),
	dmarcOverride: optional(string),
	arcSealer: optional(string),
	senderHeuristics: optional(
		object({
			isFromDomainSpoofed: optional(boolean),
			isReplyToMismatch: optional(boolean),
			isFirstTimeSender: optional(boolean),
			lookalikeOfContactDomain: optional(string),
		})
	),
	inboundEncryptionInfo: optional(
		oneOf<ReturnType<typeof decrypted> | ReturnType<typeof undecrypted>>(
			'a sealed-message state',
			decrypted,
			undecrypted
		)
	),
	inboundSignatureInfo: optional(
		object({
			isSigned: literal(true),
			isSignatureValid: boolean,
			signerFingerprint: optional(string),
			keySource: literal('pinned', 'wkd', 'manifest', 'not_found'),
			failure: optional(string),
			scope: optional(literal('clearsigned', 'mime')),
		})
	),
	followUp: optional(object({ remindAt: number, dueAt: optional(number), watched: boolean })),
	mutedAt: optional(number),
	pinnedAt: optional(number),
	snoozeReturnedAt: optional(number),
	category: optional(string),
	briefTop: optional(briefTop),
	placement: optional(string),
});

export const decodeListPage = object({
	messages: arrayOf(listRow),
	hasMore: boolean,
	nextCursor: nullable(string),
});
