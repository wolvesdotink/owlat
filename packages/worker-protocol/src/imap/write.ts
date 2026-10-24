/**
 * The IMAP server's write commands: STORE (`mail/imap/flags`), COPY / MOVE /
 * EXPUNGE (`mail/imap/move`) and APPEND (`mail/imap/append`). Each one has
 * committed by the time its answer arrives, which is why a malformed answer is
 * reported rather than retried (`WireContractError`).
 */

import { v } from 'convex/values';
import { defineEndpoint } from '../contract';

/** STORE: the rows that changed, and the CONDSTORE rows left alone. */
export const storeFlags = defineEndpoint({
	path: 'mail/imap/flags:storeFlags',
	kind: 'mutation',
	args: {
		messageIds: v.array(v.id('mailMessages')),
		flags: v.array(v.string()),
		mode: v.union(v.literal('set'), v.literal('add'), v.literal('remove')),
		unchangedSinceModseq: v.optional(v.number()),
	},
	returns: v.object({
		updated: v.array(
			v.object({
				messageId: v.id('mailMessages'),
				uid: v.number(),
				modseq: v.number(),
				flags: v.array(v.string()),
			})
		),
		unchanged: v.array(v.object({ messageId: v.id('mailMessages'), uid: v.number() })),
	}),
});

const copyMoveArgs = {
	sourceFolderId: v.id('mailFolders'),
	targetFolderId: v.id('mailFolders'),
	messageIds: v.array(v.id('mailMessages')),
};

/** COPY and MOVE answer with the `COPYUID` pairs. */
const copyMoveResult = v.object({
	uidValidity: v.number(),
	pairs: v.array(v.object({ sourceUid: v.number(), targetUid: v.number() })),
});

export const copyMessages = defineEndpoint({
	path: 'mail/imap/move:copyMessages',
	kind: 'mutation',
	args: copyMoveArgs,
	returns: copyMoveResult,
});

export const moveMessages = defineEndpoint({
	path: 'mail/imap/move:moveMessages',
	kind: 'mutation',
	args: copyMoveArgs,
	returns: copyMoveResult,
});

/**
 * One committed EXPUNGE page: the expunged UIDs, highest first, and the keyset
 * cursor (`beforeUid`) to the next page. `beforeUid` is absent only when the
 * page was empty and the caller sent none.
 */
export const expungeFolder = defineEndpoint({
	path: 'mail/imap/move:expungeFolder',
	kind: 'mutation',
	args: {
		folderId: v.id('mailFolders'),
		uidSet: v.optional(v.array(v.number())),
		beforeUid: v.optional(v.number()),
		imapWireVersion: v.optional(v.number()),
	},
	returns: v.object({
		uids: v.array(v.number()),
		modseq: v.number(),
		done: v.boolean(),
		beforeUid: v.optional(v.number()),
	}),
});

/** Undo the rows an unfinished COPY created in its target folder. */
export const discardCopies = defineEndpoint({
	path: 'mail/imap/move:discardCopies',
	kind: 'mutation',
	args: { targetFolderId: v.id('mailFolders'), uids: v.array(v.number()) },
	returns: v.object({ removed: v.number() }),
});

/** APPEND: register a message whose raw bytes the IMAP server already stored. */
export const appendMessage = defineEndpoint({
	path: 'mail/imap/append:appendMessage',
	kind: 'mutation',
	args: {
		folderId: v.id('mailFolders'),
		rawStorageId: v.id('_storage'),
		rawSize: v.number(),
		rfc822MessageId: v.string(),
		/** Bare Message-IDs from the In-Reply-To / References headers. */
		inReplyTo: v.optional(v.string()),
		references: v.optional(v.array(v.string())),
		fromAddress: v.string(),
		fromName: v.optional(v.string()),
		toAddresses: v.array(v.string()),
		ccAddresses: v.array(v.string()),
		bccAddresses: v.array(v.string()),
		subject: v.string(),
		htmlBodyInline: v.optional(v.string()),
		textBodyInline: v.optional(v.string()),
		internalDate: v.optional(v.number()),
		flags: v.optional(v.array(v.string())),
		// The raw header section: its automation headers (Auto-Submitted, List-Id,
		// Precedence) keep a client's filed vacation reply from counting as one.
		headerBlock: v.optional(v.string()),
	},
	// What `[APPENDUID …]` reports.
	returns: v.object({
		messageId: v.id('mailMessages'),
		uid: v.number(),
		uidValidity: v.number(),
		modseq: v.number(),
	}),
});

/** The upload URL APPEND stores the raw bytes through before `appendMessage`. */
export const generateUploadUrl = defineEndpoint({
	path: 'mail/imap/append:generateRawUploadUrl',
	kind: 'mutation',
	args: {},
	returns: v.string(),
});
