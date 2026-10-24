/**
 * The IMAP server's reads behind FETCH, its sequence-number map and IDLE
 * (`mail/imap/fetch`). Every folder-scoped read is a page plus the cursor to
 * resume from; see that module for why.
 */

import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { v, type Infer } from 'convex/values';
import { defineEndpoint } from '../contract';
import { mailMessageAttachmentValidator } from '../fields';

/** The IMAP-visible projection of a message row. */
export const imapEnvelopeValidator = v.object({
	_id: v.id('mailMessages'),
	uid: v.number(),
	modseq: v.number(),
	rawSize: v.number(),
	rfc822MessageId: v.string(),
	inReplyTo: v.optional(v.string()),
	references: v.optional(v.array(v.string())),
	fromAddress: v.string(),
	fromName: v.optional(v.string()),
	toAddresses: v.array(v.string()),
	ccAddresses: v.array(v.string()),
	bccAddresses: v.array(v.string()),
	replyToAddress: v.optional(v.string()),
	subject: v.string(),
	internalDate: v.number(),
	attachments: v.array(mailMessageAttachmentValidator),
	hasAttachments: v.boolean(),
	flagSeen: v.boolean(),
	flagFlagged: v.boolean(),
	flagAnswered: v.boolean(),
	flagDraft: v.boolean(),
	flagDeleted: v.boolean(),
	customFlags: v.array(v.string()),
});
export type ImapEnvelope = Infer<typeof imapEnvelopeValidator>;

/**
 * A UID window read: `[uidLow, uidHigh]`, optionally narrowed to ascending,
 * disjoint `ranges` (at most `MAX_UID_RANGES` in apps/api `mail/imap/fetch.ts`).
 */
const uidWindowArgs = {
	folderId: v.id('mailFolders'),
	uidLow: v.number(),
	uidHigh: v.number(),
	ranges: v.optional(v.array(v.object({ low: v.number(), high: v.number() }))),
	limit: v.optional(v.number()),
};

/** `nextUid` is null once the requested window is exhausted. */
const nextUidValidator = v.union(v.number(), v.null());

/** One page of envelopes inside a UID window, ascending. */
export const fetchEnvelopes = defineEndpoint({
	path: 'mail/imap/fetch:fetchEnvelopes',
	kind: 'query',
	args: uidWindowArgs,
	returns: v.object({ rows: v.array(imapEnvelopeValidator), nextUid: nextUidValidator }),
});

/**
 * One cursor page of the rows whose modseq moved past a baseline. The answer is
 * Convex's own pagination result, `splitCursor` / `pageStatus` included.
 */
export const fetchChangedEnvelopes = defineEndpoint({
	path: 'mail/imap/fetch:fetchChangedEnvelopes',
	kind: 'query',
	args: {
		folderId: v.id('mailFolders'),
		modseqSince: v.number(),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(imapEnvelopeValidator),
});

/** One page of a folder's UIDs, ascending. */
export const listFolderUidsPage = defineEndpoint({
	path: 'mail/imap/fetch:listFolderUidsPage',
	kind: 'query',
	args: {
		folderId: v.id('mailFolders'),
		afterUid: v.optional(v.number()),
		limit: v.optional(v.number()),
	},
	returns: v.object({ uids: v.array(v.number()), nextUid: nextUidValidator }),
});

/**
 * A folder's membership read: `null` when the folder is not maintained,
 * `unchanged` when `knownVersion` is still current, `isReady: false` while its
 * backfill runs, otherwise one page of UID blocks (each ascending, the blocks
 * in order) and the bound to resume after.
 */
export const folderMembershipPage = defineEndpoint({
	path: 'mail/imap/fetch:folderMembershipPage',
	kind: 'query',
	args: {
		folderId: v.id('mailFolders'),
		knownVersion: v.optional(v.string()),
		afterFirstUid: v.optional(v.number()),
	},
	returns: v.union(
		v.null(),
		v.object({ version: v.string(), isReady: v.boolean(), unchanged: v.literal(true) }),
		v.object({ version: v.string(), isReady: v.literal(false) }),
		v.object({
			version: v.string(),
			isReady: v.literal(true),
			blocks: v.array(v.array(v.number())),
			nextFirstUid: v.union(v.number(), v.null()),
		})
	),
});

/** One page of `{ _id, uid, modseq }` inside a UID window: the STORE / COPY id map. */
export const resolveMessageIdsByUid = defineEndpoint({
	path: 'mail/imap/fetch:resolveMessageIdsByUid',
	kind: 'query',
	args: uidWindowArgs,
	returns: v.object({
		rows: v.array(v.object({ _id: v.id('mailMessages'), uid: v.number(), modseq: v.number() })),
		nextUid: nextUidValidator,
	}),
});

/** `FETCH … BODY[]`: a download URL per message, null for one that is gone. */
export const getRawStorageUrls = defineEndpoint({
	path: 'mail/imap/fetch:getRawStorageUrls',
	kind: 'action',
	args: { messageIds: v.array(v.id('mailMessages')) },
	returns: v.array(
		v.object({ messageId: v.id('mailMessages'), url: v.union(v.string(), v.null()) })
	),
});
