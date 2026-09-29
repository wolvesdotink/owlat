/**
 * Personal-mail delivery pipeline — the argument fields every ingest entry
 * point shares.
 *
 * Five Convex functions land a message through `insertDeliveredMessage`: the
 * hosted MX action and mutation (`mail/delivery.ts`), the IMAP-sync action and
 * mutation (`mail/external/delivery.ts`) and the archive import mutation
 * (`mail/archiveImport.ts`). They used to spell these validators out one by
 * one, so a new message field had to be added to five argument blocks. They
 * are plain records of validators, spread into each `args`, so each function
 * keeps its own flat argument shape.
 */

import { v } from 'convex/values';
import { mailMessageAttachmentValidator } from '../../lib/validators/mailContent';

/** The addressing and identity headers of a delivered message. */
export const deliveredEnvelopeFields = {
	from: v.string(),
	to: v.array(v.string()),
	cc: v.array(v.string()),
	bcc: v.array(v.string()),
	replyTo: v.optional(v.string()),
	subject: v.string(),
	/** Raw `Message-ID` header; the insert step canonicalises it. */
	messageId: v.string(),
	inReplyTo: v.optional(v.string()),
	references: v.optional(v.string()),
	attachments: v.array(mailMessageAttachmentValidator),
};

/**
 * The stored form of a message's body and raw source, as the insert mutations
 * receive it: each body either inline or already split into a blob, plus the
 * staged raw `.eml`. The ingest actions compute these, so they take the
 * envelope fields only.
 */
export const storedBodyFields = {
	textBodyInline: v.optional(v.string()),
	textBodyStorageId: v.optional(v.id('_storage')),
	htmlBodyInline: v.optional(v.string()),
	htmlBodyStorageId: v.optional(v.id('_storage')),
	snippet: v.optional(v.string()),
	// Deep-search excerpt (idea 32). Always sent by the ingest action; the
	// insert step drops it unless the instance opted in.
	searchBody: v.optional(v.string()),
	receivedAt: v.number(),
	rawStorageId: v.id('_storage'),
	rawSize: v.number(),
};
