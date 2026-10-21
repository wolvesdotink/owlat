/**
 * The field vocabulary the worker wire shares with the mail tables.
 *
 * Each validator here is BOTH a column in apps/api's schema and a field the IMAP
 * server or the mail-sync worker sends or reads, so it is declared once, here,
 * and apps/api re-exports it from the module that used to own it
 * (`lib/validators/mail.ts`, `lib/validators/mailContent.ts`, …). A second
 * declaration on either side is what lets the stored shape and the wire shape
 * drift apart.
 */

import { v, type Infer } from 'convex/values';

/**
 * The six folders every mailbox is provisioned with. Also the accepted
 * `folderRole` values on the read views (`queries.listMessages`,
 * `queries.listThreads`, `search.search`).
 */
export const SYSTEM_FOLDER_ROLES = ['inbox', 'sent', 'drafts', 'trash', 'spam', 'archive'] as const;
export type FolderRole = (typeof SYSTEM_FOLDER_ROLES)[number];
/** The same six roles as a Convex validator, for `mailFolders.role` and the folder-scoped args. */
export const folderRoleValidator = v.union(
	v.literal('inbox'),
	v.literal('sent'),
	v.literal('drafts'),
	v.literal('trash'),
	v.literal('spam'),
	v.literal('archive')
);

/** Which protocol an app password signs in to. */
export const mailAppPasswordScopeValidator = v.union(v.literal('imap'), v.literal('smtp'));

/** Attachment metadata embedded in raw .eml (`mailMessages.attachments`). */
export const mailMessageAttachmentValidator = v.object({
	filename: v.string(),
	contentType: v.string(),
	size: v.number(),
	contentId: v.optional(v.string()),
	partIndex: v.string(),
});

/**
 * The addressing and identity headers of a delivered message: the argument
 * fields every ingest entry point shares (the hosted MX path, the IMAP-sync
 * ingest the mail-sync worker calls, the archive import). A plain record of
 * validators, spread into each `args`, so each function keeps its own flat
 * argument shape.
 */
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

/** A connected external account's connection state. */
export const externalAccountStatusValidator = v.union(
	v.literal('pending'), // created; worker not yet connected
	v.literal('connected'), // IMAP IDLE live
	v.literal('auth_error'), // bad credentials — needs user fix
	v.literal('error'), // transient/connection error (backoff)
	v.literal('disconnected') // user paused / removed
);

/**
 * A folder on the REMOTE server of a connected external account, named the
 * way the local side can name it: a system folder by role (the mail-sync
 * worker maps it through its own folder discovery), or a user folder by its
 * chain of local folder names, outermost first (the worker joins them with the
 * server's delimiter and creates the folder when it is missing).
 */
export const remoteFolderRefValidator = v.union(
	v.object({ role: folderRoleValidator }),
	v.object({ path: v.array(v.string()) }),
	// A folder the worker has mapped, by its exact remote name.
	v.object({ remote: v.string() })
);
export type RemoteFolderRef = Infer<typeof remoteFolderRefValidator>;

/**
 * Where the mail-sync worker last saw the provider of a connected external
 * account hold a message: the remote folder, its UIDVALIDITY and the UID. It
 * is the evidence that the provider once had the message, so a message that
 * has since left that folder and is nowhere else counts as deleted there, even
 * when the worker was not running at the time (`mail/external/remoteState.ts`).
 */
export const remoteSightingValidator = v.object({
	remoteName: v.string(),
	uidValidity: v.number(),
	uid: v.number(),
});
export type RemoteSighting = Infer<typeof remoteSightingValidator>;

/** 'full' — two-way sync; 'incoming' — only new mail comes in. */
export const EXTERNAL_SYNC_MODES = ['full', 'incoming'] as const;
export type ExternalSyncMode = (typeof EXTERNAL_SYNC_MODES)[number];
export const externalSyncModeValidator = v.union(v.literal('full'), v.literal('incoming'));

/** What one queued write-back (`externalMailRemoteOps`) does. */
export const remoteOpKindValidator = v.union(
	v.literal('move'),
	v.literal('flags'),
	v.literal('delete'),
	// A mirrored folder renamed or deleted in Owlat.
	v.literal('renameFolder'),
	v.literal('deleteFolder')
);

/** The flags a remote write-back sets (`true`) or clears (`false`); absent ⇒ untouched. */
export const remoteFlagChangesValidator = v.object({
	seen: v.optional(v.boolean()),
	flagged: v.optional(v.boolean()),
	answered: v.optional(v.boolean()),
});
