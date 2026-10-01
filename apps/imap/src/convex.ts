/**
 * Convex client wrapper used by the IMAP server.
 *
 * We use the HTTP transport so each connection can run its own client
 * with admin auth. For IDLE we also support a long-lived subscription
 * via the websocket client, but P4 (read-only) only needs HTTP.
 */

import { createAdminConvexClient } from '@owlat/shared';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import type { ImapConfig } from './config.js';
import type { FetchEnvelope } from './commands/fetch/format.js';

export type ConvexClient = ConvexHttpClient;

export function createConvexClient(config: ImapConfig): ConvexClient {
	return createAdminConvexClient(ConvexHttpClient, config.convexUrl, config.convexAdminKey);
}

// ── Wire shapes ─────────────────────────────────────────────────────────────
// What the `mail/*` functions below answer with. Ids travel as plain strings:
// this workspace does not import apps/api's generated `_generated/api.d.ts`
// (that would couple the workspaces), so the shapes are declared here, once,
// at the call boundary.

/** A verified app password: the session's identity. */
export interface VerifyAppPasswordResult {
	readonly mailboxId: string;
	readonly appPasswordId: string;
	readonly userId: string;
	readonly organizationId: string;
}

/** One LIST row. */
export interface FolderRow {
	readonly _id: string;
	readonly name: string;
	readonly role?: string;
	readonly parentId?: string;
	readonly subscribed?: boolean;
	readonly uidValidity?: number;
	readonly uidNext?: number;
	readonly highestModseq?: number;
	readonly totalCount?: number;
	readonly unseenCount?: number;
}

/** SELECT / EXAMINE: folder metadata plus the first unseen message. */
export interface SelectFolderResult {
	readonly folder: {
		readonly _id: string;
		readonly name: string;
		readonly role?: string;
		readonly uidValidity: number;
		readonly uidNext: number;
		readonly highestModseq: number;
		readonly totalCount: number;
		readonly unseenCount: number;
	};
	readonly firstUnseenUid?: number;
	readonly firstUnseenSeq?: number;
}

/** The counters IDLE polls to notice a change. */
export interface PeekResult {
	readonly highestModseq: number;
	readonly uidNext: number;
	readonly totalCount: number;
	readonly unseenCount: number;
}

/** One page of a folder's UIDs, ascending; `nextUid` is null once done. */
export interface UidPage {
	readonly uids: number[];
	readonly nextUid: number | null;
}

/** One page of envelopes inside a UID window. */
export interface EnvelopePage {
	readonly rows: FetchEnvelope[];
	readonly nextUid: number | null;
}

/** One page of `{ _id, uid, modseq }` inside a UID window. */
export interface MessageIdPage {
	readonly rows: Array<{ _id: string; uid: number; modseq: number }>;
	readonly nextUid: number | null;
}

/** One cursor page of the rows whose modseq moved past a baseline. */
export interface ChangedEnvelopePage {
	readonly page: FetchEnvelope[];
	readonly isDone: boolean;
	readonly continueCursor: string | null;
}

/** STORE: the rows that changed, and the CONDSTORE rows left alone. */
export interface StoreFlagsResult {
	readonly updated: ReadonlyArray<{
		messageId: string;
		uid: number;
		modseq: number;
		flags: string[];
	}>;
	readonly unchanged: ReadonlyArray<{ messageId: string; uid: number }>;
}

/** COPY and MOVE: the `COPYUID` pairs. */
export interface CopyMoveResult {
	readonly uidValidity: number;
	readonly pairs: ReadonlyArray<{ sourceUid: number; targetUid: number }>;
}

/** One committed EXPUNGE page, plus the cursor to the next one. */
export interface ExpungeResult {
	readonly sequenceNumbers: number[];
	readonly modseq: number;
	readonly done?: boolean;
	readonly beforeUid?: number;
	readonly nextSequenceNumber?: number;
}

/** APPEND: what `[APPENDUID …]` reports. */
export interface AppendResult {
	readonly messageId: string;
	readonly uid: number;
	readonly uidValidity: number;
	readonly modseq: number;
}

/**
 * A UID window read: `[uidLow, uidHigh]`, optionally narrowed to ascending,
 * disjoint `ranges` (at most `MAX_UID_RANGES` in apps/api `mail/imap/fetch.ts`).
 */
type UidWindowArgs = {
	folderId: string;
	uidLow: number;
	uidHigh: number;
	ranges?: Array<{ low: number; high: number }>;
	limit?: number;
};

type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'archive';

type CopyMoveArgs = {
	sourceFolderId: string;
	targetFolderId: string;
	messageIds: string[];
};

type AppendArgs = {
	folderId: string;
	rawStorageId: string;
	rawSize: number;
	rfc822MessageId: string;
	inReplyTo?: string;
	references?: string[];
	fromAddress: string;
	fromName?: string;
	toAddresses: string[];
	ccAddresses: string[];
	bccAddresses: string[];
	subject: string;
	htmlBodyInline?: string;
	textBodyInline?: string;
	internalDate?: number;
	flags?: string[];
};

/**
 * Typed references to the internal Convex functions the IMAP server calls.
 *
 * Convex addresses functions by their module path (directory + filename,
 * minus the .ts), so functions in convex/mail/imap/session.ts and
 * convex/mail/appPasswords.ts are referenced as `mail/imap/session:fn` /
 * `mail/appPasswords:fn`. The kind, argument and result types are declared by
 * hand because apps/api's generated types are not imported: a wrong argument
 * or a query called as a mutation is a type error at the call site, but the
 * declarations themselves must be kept in step with apps/api. The
 * convexRefs test checks each path and kind against the Convex source.
 *
 * Keep every path a single-quoted literal inside its makeFunctionReference
 * call: apps/api/scripts/check-entry-wiring.ts credits callers by it.
 */
export const fn = {
	verifyAppPassword: makeFunctionReference<
		'action',
		{ address: string; password: string; scope: 'imap' | 'smtp'; ip?: string },
		VerifyAppPasswordResult | null
	>('mail/appPasswords:verify'),
	touchAppPassword: makeFunctionReference<
		'mutation',
		{ appPasswordId: string; ip?: string; userAgent?: string },
		null
	>('mail/appPasswords:touch'),
	listFolders: makeFunctionReference<'query', { mailboxId: string }, FolderRow[]>(
		'mail/imap/session:listFolders'
	),
	selectFolder: makeFunctionReference<'query', { folderId: string }, SelectFolderResult | null>(
		'mail/imap/session:selectFolder'
	),
	fetchEnvelopes: makeFunctionReference<'query', UidWindowArgs, EnvelopePage>(
		'mail/imap/fetch:fetchEnvelopes'
	),
	fetchChangedEnvelopes: makeFunctionReference<
		'query',
		{
			folderId: string;
			modseqSince: number;
			paginationOpts: { numItems: number; cursor: string | null };
		},
		ChangedEnvelopePage
	>('mail/imap/fetch:fetchChangedEnvelopes'),
	listFolderUidsPage: makeFunctionReference<
		'query',
		{ folderId: string; afterUid?: number; limit?: number },
		UidPage
	>('mail/imap/fetch:listFolderUidsPage'),
	peekFolderModseq: makeFunctionReference<'query', { folderId: string }, PeekResult | null>(
		'mail/imap/session:peekFolderModseq'
	),
	resolveSpecialFolder: makeFunctionReference<
		'query',
		{ mailboxId: string; role: FolderRole },
		{ _id: string; name: string } | null
	>('mail/imap/session:resolveSpecialFolder'),
	// P5 — write commands
	storeFlags: makeFunctionReference<
		'mutation',
		{
			messageIds: string[];
			flags: string[];
			mode: 'set' | 'add' | 'remove';
			unchangedSinceModseq?: number;
		},
		StoreFlagsResult
	>('mail/imap/flags:storeFlags'),
	copyMessages: makeFunctionReference<'mutation', CopyMoveArgs, CopyMoveResult>(
		'mail/imap/move:copyMessages'
	),
	moveMessages: makeFunctionReference<'mutation', CopyMoveArgs, CopyMoveResult>(
		'mail/imap/move:moveMessages'
	),
	expungeFolder: makeFunctionReference<
		'mutation',
		{ folderId: string; uidSet?: number[]; beforeUid?: number; nextSequenceNumber?: number },
		ExpungeResult
	>('mail/imap/move:expungeFolder'),
	appendMessage: makeFunctionReference<'mutation', AppendArgs, AppendResult>(
		'mail/imap/append:appendMessage'
	),
	resolveMessageIdsByUid: makeFunctionReference<'query', UidWindowArgs, MessageIdPage>(
		'mail/imap/fetch:resolveMessageIdsByUid'
	),
	getRawStorageUrls: makeFunctionReference<
		'action',
		{ messageIds: string[] },
		Array<{ messageId: string; url: string | null }>
	>('mail/imap/fetch:getRawStorageUrls'),
	generateUploadUrl: makeFunctionReference<'mutation', Record<string, never>, string>(
		'mail/imap/append:generateRawUploadUrl'
	),
};
