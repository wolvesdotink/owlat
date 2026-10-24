/**
 * The mail-sync worker's forward-sync calls (`mail/external/delivery`): ingest
 * one message, free a staged upload, and the per-folder cursors.
 */

import { v } from 'convex/values';
import { defineEndpoint } from '../contract';
import { deliveredEnvelopeFields, folderRoleValidator } from '../fields';

/**
 * Ingest one synced message whose raw `.eml` the worker already uploaded to
 * `/mail-sync/raw-message`.
 *
 * `duplicate` means the message is ALREADY in the mailbox, so it counts as
 * landed; `no_target` means the account, mailbox or folder it belongs in is
 * gone and nothing was stored.
 */
export const ingestExternalRaw = defineEndpoint({
	path: 'mail/external/delivery:ingestExternalRaw',
	kind: 'action',
	args: {
		accountId: v.id('externalMailAccounts'),
		folderRole: v.optional(folderRoleValidator),
		remoteName: v.string(),
		remoteUid: v.number(),
		remoteUidValidity: v.number(),
		/** Sealed raw `.eml`, already stored by `/mail-sync/raw-message`. */
		rawStorageId: v.id('_storage'),
		/** Size of the raw message in bytes, as uploaded. */
		rawSize: v.number(),
		/** First 64 KiB of the raw message, base64 — the header block. */
		headerBlockBase64: v.string(),
		...deliveredEnvelopeFields,
		textBodyInline: v.optional(v.string()),
		htmlBodyInline: v.optional(v.string()),
		receivedAt: v.number(),
		flagSeen: v.optional(v.boolean()),
		flagFlagged: v.optional(v.boolean()),
		// The provider's `\Draft` (an unsent draft outside the Drafts folder).
		flagDraft: v.optional(v.boolean()),
		// Forward sync vs historical import.
		origin: v.optional(v.union(v.literal('sync'), v.literal('backfill'))),
	},
	returns: v.union(
		v.object({ messageId: v.id('mailMessages') }),
		v.object({ skipped: v.union(v.literal('duplicate'), v.literal('no_target')) })
	),
});

/** Free the raw upload of a staged message the pipeline will never commit. */
export const discardStagedRaw = defineEndpoint({
	path: 'mail/external/delivery:discardStagedRaw',
	kind: 'mutation',
	args: { rawStorageId: v.id('_storage') },
	returns: v.null(),
});

/** The per-folder resume cursors, read on (re)connect. */
export const getSyncState = defineEndpoint({
	path: 'mail/external/delivery:getSyncState',
	kind: 'query',
	args: { accountId: v.id('externalMailAccounts') },
	returns: v.array(
		v.object({
			remoteName: v.string(),
			remoteUidValidity: v.number(),
			lastSeenUid: v.number(),
			folderId: v.id('mailFolders'),
			forwardIngestFailures: v.array(v.object({ uid: v.number(), attempts: v.number() })),
			forwardIngestFailureCount: v.number(),
		})
	),
});

/** Record a remote→local folder mapping and its initial high-water UID. */
export const recordFolderMapping = defineEndpoint({
	path: 'mail/external/delivery:recordFolderMapping',
	kind: 'mutation',
	args: {
		accountId: v.id('externalMailAccounts'),
		// A system folder by role, or — full sync — a provider user folder by its
		// path of names, which gets a local folder of its own.
		folderRole: v.optional(folderRoleValidator),
		folderPath: v.optional(v.array(v.string())),
		remoteName: v.string(),
		remoteUidValidity: v.number(),
		initialLastSeenUid: v.number(),
	},
	returns: v.null(),
});

/** Persist one forward-sync miss: retry it, or give up after `attempts`. */
export const recordForwardIngestFailure = defineEndpoint({
	path: 'mail/external/delivery:recordForwardIngestFailure',
	kind: 'mutation',
	args: {
		accountId: v.id('externalMailAccounts'),
		remoteName: v.string(),
		remoteUidValidity: v.number(),
		uid: v.number(),
	},
	returns: v.object({ retry: v.boolean(), attempts: v.number() }),
});
