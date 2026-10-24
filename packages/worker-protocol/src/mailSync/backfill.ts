/**
 * The historical import the mail-sync worker runs for a migration
 * (`mail/migrationBackfill`): whether one is importing, each folder's
 * descending cursor, and how the run ends.
 */

import { v } from 'convex/values';
import { defineEndpoint } from '../contract';

/**
 * Whether a migration is importing for the account, and which one: every write
 * of the run carries `migrationId`. `resumesAt` is a persisted throttle pause.
 */
export const getBackfillWork = defineEndpoint({
	path: 'mail/migrationBackfill:getBackfillWork',
	kind: 'query',
	args: { accountId: v.id('externalMailAccounts') },
	returns: v.union(
		v.object({ isActive: v.literal(false), migrationId: v.null() }),
		v.object({
			isActive: v.literal(true),
			migrationId: v.id('mailboxMigrations'),
			resumesAt: v.optional(v.number()),
		})
	),
});

/** Snapshot a folder's high-water UID and count; null once the migration is not importing. */
export const initFolderBackfill = defineEndpoint({
	path: 'mail/migrationBackfill:initFolderBackfill',
	kind: 'mutation',
	args: {
		accountId: v.id('externalMailAccounts'),
		migrationId: v.id('mailboxMigrations'),
		remoteName: v.string(),
		ceilingUid: v.number(),
		messageCount: v.number(),
	},
	returns: v.union(v.null(), v.object({ startCursor: v.number() })),
});

/** Which of a batch's raw Message-IDs the mailbox already holds (the caller's own strings). */
export const findKnownMessageIds = defineEndpoint({
	path: 'mail/migrationBackfill:findKnownMessageIds',
	kind: 'query',
	args: {
		accountId: v.id('externalMailAccounts'),
		/** Raw Message-ID headers, as the remote server reported them. */
		messageIds: v.array(v.string()),
	},
	returns: v.array(v.string()),
});

/** Persist one descending batch; `stillImporting: false` stops the walk. */
export const recordBackfillProgress = defineEndpoint({
	path: 'mail/migrationBackfill:recordBackfillProgress',
	kind: 'mutation',
	args: {
		accountId: v.id('externalMailAccounts'),
		migrationId: v.id('mailboxMigrations'),
		remoteName: v.string(),
		newCursor: v.number(),
		/** Messages in this batch the worker STORED. */
		importedDelta: v.number(),
		/** Messages in this batch it walked past without storing. Required so an
		 * older worker cannot report failed ingests as successful imports during a
		 * rolling deploy; the resumable cursor makes a brief loud failure safe. */
		failedDelta: v.number(),
	},
	returns: v.object({ stillImporting: v.boolean() }),
});

/** Every folder is backfilled: hand the migration on to finalize. */
export const completeBackfillImport = defineEndpoint({
	path: 'mail/migrationBackfill:completeBackfillImport',
	kind: 'mutation',
	args: { migrationId: v.id('mailboxMigrations') },
	returns: v.null(),
});

/** The walk threw and will not heal on its own: fail the migration. */
export const markImportFailed = defineEndpoint({
	path: 'mail/migrationBackfill:markImportFailed',
	kind: 'mutation',
	args: { migrationId: v.id('mailboxMigrations'), errorMessage: v.optional(v.string()) },
	returns: v.null(),
});

/** The provider's budget is spent: hold the migration until `resumeAt`. */
export const pauseImportForThrottle = defineEndpoint({
	path: 'mail/migrationBackfill:pauseImportForThrottle',
	kind: 'mutation',
	args: {
		migrationId: v.id('mailboxMigrations'),
		/** Epoch ms the worker will run the walk again. */
		resumeAt: v.number(),
		/** The provider's own words, for the audit log. */
		reason: v.optional(v.string()),
	},
	returns: v.object({
		outcome: v.union(v.literal('paused'), v.literal('failed'), v.literal('ignored')),
	}),
});
