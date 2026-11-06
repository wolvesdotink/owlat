/**
 * Local → remote write-back (`mail/external/remoteOps`,
 * `mail/external/remoteFolderRename`): the moves, flag changes, deletes,
 * uploads and folder renames made in Owlat that the worker replays on the
 * provider.
 *
 * An `append` op carries no message bytes: the worker fetches them by op id
 * from the backend's `GET /mail-sync/raw-message?opId=…` route, which answers
 * 404 once the message is gone.
 */

import { v, type Infer } from 'convex/values';
import { defineEndpoint } from '../contract';
import {
	remoteFlagChangesValidator,
	remoteFolderRefValidator,
	remoteOpKindValidator,
} from '../fields';

/** One queued write-back, as the worker replays it. */
export const remoteOpValidator = v.object({
	opId: v.id('externalMailRemoteOps'),
	kind: remoteOpKindValidator,
	/** Absent on the two folder kinds. */
	rfc822MessageId: v.optional(v.string()),
	/** For `append`, the folder the message is uploaded into, as `target` names it. */
	source: remoteFolderRefValidator,
	target: v.optional(remoteFolderRefValidator),
	/** For `append`, the flags the uploaded message carries (`true` ones only). */
	flags: v.optional(remoteFlagChangesValidator),
	/** `append` only: the message's received time, sent as its INTERNALDATE. */
	receivedAt: v.optional(v.number()),
	attempts: v.number(),
});
export type RemoteOpWire = Infer<typeof remoteOpValidator>;

export const remoteOpOutcomeValidator = v.union(
	v.literal('done'),
	v.literal('not_found'),
	v.literal('failed')
);

/**
 * The account's due write-backs, oldest first; empty unless it writes back.
 * `append` ops are listed only to a worker that says it can run them
 * (`appends: true`): a worker from before them would refuse the whole page.
 */
export const listDueRemoteOps = defineEndpoint({
	path: 'mail/external/remoteOps:listDueRemoteOps',
	kind: 'query',
	args: { accountId: v.id('externalMailAccounts'), appends: v.optional(v.boolean()) },
	returns: v.array(remoteOpValidator),
});

/**
 * Close out a replayed batch: `done` / `not_found` retire an op, `failed` backs
 * it off. A settled `append` finishes or abandons the transfer it belongs to.
 */
export const settleRemoteOps = defineEndpoint({
	path: 'mail/external/remoteOps:settleRemoteOps',
	kind: 'mutation',
	args: {
		results: v.array(
			v.object({
				opId: v.id('externalMailRemoteOps'),
				outcome: remoteOpOutcomeValidator,
				error: v.optional(v.string()),
			})
		),
	},
	returns: v.null(),
});

/** A folder the worker renamed: rewrite its mapping and the ops still naming the old name. */
export const recordRemoteFolderRename = defineEndpoint({
	path: 'mail/external/remoteFolderRename:recordRemoteFolderRename',
	kind: 'mutation',
	args: {
		opId: v.id('externalMailRemoteOps'),
		remoteName: v.string(),
		delimiter: v.string(),
	},
	returns: v.null(),
});

/** One page of the account's queued folder renames not yet recorded. */
export const listQueuedFolderRenames = defineEndpoint({
	path: 'mail/external/remoteFolderRename:listQueuedFolderRenames',
	kind: 'query',
	args: {
		accountId: v.id('externalMailAccounts'),
		cursor: v.optional(v.union(v.string(), v.null())),
	},
	returns: v.object({
		page: v.array(remoteOpValidator),
		isDone: v.boolean(),
		continueCursor: v.string(),
	}),
});
