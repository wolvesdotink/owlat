/**
 * Remote → local change sync (`mail/external/remoteState`): the worker compares
 * the provider's folders and flags with the local mailbox and reports what it
 * saw; the backend decides what to pull and what to push back.
 */

import { paginationOptsValidator } from 'convex/server';
import { v, type Infer } from 'convex/values';
import { defineEndpoint } from '../contract';
import { externalSyncModeValidator, folderRoleValidator, remoteSightingValidator } from '../fields';

/** The three flags both sides keep in step. */
export const flagStateValidator = v.object({
	seen: v.boolean(),
	flagged: v.boolean(),
	answered: v.boolean(),
});

/** One local message as the worker compares it with the provider. */
export const localMessageRowValidator = v.object({
	messageId: v.string(),
	/** Remote folder the local folder syncs with; null for a local-only folder. */
	remoteName: v.union(v.string(), v.null()),
	role: v.union(folderRoleValidator, v.null()),
	flags: flagStateValidator,
	/** Where the provider was last seen holding it; null if it never was. */
	sighting: v.union(remoteSightingValidator, v.null()),
});
export type LocalMessageRowWire = Infer<typeof localMessageRowValidator>;

/** What the worker saw of one message at the provider. */
export const remoteObservationValidator = v.object({
	messageId: v.string(),
	remoteFolders: v.optional(v.array(v.string())),
	isGone: v.optional(v.boolean()),
	flags: v.optional(flagStateValidator),
	/** Where the tracked folders hold it now; each local copy records its own folder's. */
	sightings: v.optional(v.array(remoteSightingValidator)),
	/** Drop the recorded sightings: a merge found the message in no synced folder. */
	forgetSightings: v.optional(v.boolean()),
});

/** The account's sync mode, read every cycle so a switch applies at once. */
export const getSyncSettings = defineEndpoint({
	path: 'mail/external/remoteState:getSyncSettings',
	kind: 'query',
	args: { accountId: v.id('externalMailAccounts') },
	returns: v.object({ mode: externalSyncModeValidator, isAligned: v.boolean() }),
});

/** One page of the mailbox's messages — the full reconcile. */
export const listLocalMessages = defineEndpoint({
	path: 'mail/external/remoteState:listLocalMessages',
	kind: 'query',
	args: { accountId: v.id('externalMailAccounts'), paginationOpts: paginationOptsValidator },
	returns: v.object({
		page: v.array(localMessageRowValidator),
		isDone: v.boolean(),
		continueCursor: v.string(),
	}),
});

/** The local copies of the given Message-IDs — the incremental reconcile. */
export const lookupLocalMessages = defineEndpoint({
	path: 'mail/external/remoteState:lookupLocalMessages',
	kind: 'query',
	args: { accountId: v.id('externalMailAccounts'), messageIds: v.array(v.string()) },
	returns: v.array(localMessageRowValidator),
});

/** Apply what the worker saw: `pulled` changed locally, `pushed` queued back to the provider. */
export const applyRemoteObservations = defineEndpoint({
	path: 'mail/external/remoteState:applyRemoteObservations',
	kind: 'mutation',
	args: {
		accountId: v.id('externalMailAccounts'),
		observations: v.array(remoteObservationValidator),
	},
	returns: v.object({ pulled: v.number(), pushed: v.number() }),
});

/** The first full merge is done: from now on the provider's state wins. */
export const markFullSyncAligned = defineEndpoint({
	path: 'mail/external/remoteState:markFullSyncAligned',
	kind: 'mutation',
	args: { accountId: v.id('externalMailAccounts') },
	returns: v.null(),
});

/** Forget the mappings of remote folders the provider no longer lists. */
export const forgetRemoteFolders = defineEndpoint({
	path: 'mail/external/remoteState:forgetRemoteFolders',
	kind: 'mutation',
	args: {
		accountId: v.id('externalMailAccounts'),
		listed: v.array(v.string()),
		retired: v.optional(v.array(v.string())),
	},
	returns: v.object({ forgotten: v.number() }),
});
