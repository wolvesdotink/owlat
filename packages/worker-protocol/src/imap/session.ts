/**
 * The IMAP server's session calls: LOGIN (`mail/appPasswords`), the wire-version
 * handshake (`mail/imap/serverRegistry`), and the folder reads that open a
 * session and notice a change (`mail/imap/session`).
 */

import { v } from 'convex/values';
import { defineEndpoint } from '../contract';
import { folderRoleValidator, mailAppPasswordScopeValidator } from '../fields';

/** LOGIN / AUTHENTICATE: a verified app password is the session's identity. */
export const verifyAppPassword = defineEndpoint({
	path: 'mail/appPasswords:verify',
	kind: 'action',
	args: {
		address: v.string(),
		password: v.string(),
		scope: mailAppPasswordScopeValidator,
		// The logging-in client's IP (the IMAP peer, or the SMTP peer the MTA
		// forwarded), keyed per client by the shared auth-failure table.
		ip: v.optional(v.string()),
		// The IMAP server's wire version; absent from IMAP servers that predate
		// reporting and from SMTP submission.
		imapWireVersion: v.optional(v.number()),
	},
	// null on any refusal: a wrong password, a throttled caller, personal mail off.
	returns: v.union(
		v.null(),
		v.object({
			mailboxId: v.id('mailboxes'),
			appPasswordId: v.id('mailAppPasswords'),
			userId: v.string(),
			organizationId: v.string(),
		})
	),
});

/**
 * Record a successful sign-in. Also called by SMTP submission (`channel:
 * 'smtp'`); a call with neither `imapWireVersion` nor `channel` comes from an
 * IMAP server too old to report itself.
 */
export const touchAppPassword = defineEndpoint({
	path: 'mail/appPasswords:touch',
	kind: 'mutation',
	args: {
		appPasswordId: v.id('mailAppPasswords'),
		ip: v.optional(v.string()),
		userAgent: v.optional(v.string()),
		imapWireVersion: v.optional(v.number()),
		channel: v.optional(v.literal('smtp')),
	},
	returns: v.null(),
});

const imapServerReportFields = {
	backendWireVersion: v.number(),
	minSupportedWireVersion: v.number(),
	compatible: v.boolean(),
};

/**
 * The wire-version handshake. The IMAP server reads `reason` as a hint only: a
 * refusal it has no name for is a later backend's reason, so it accepts any
 * string there while the backend produces exactly the two it knows.
 */
export const reportServer = defineEndpoint({
	path: 'mail/imap/serverRegistry:report',
	kind: 'mutation',
	args: {
		instanceId: v.string(),
		hostLabel: v.string(),
		owlatVersion: v.string(),
		wireVersion: v.number(),
		startedAt: v.number(),
	},
	returns: v.object({
		...imapServerReportFields,
		reason: v.optional(v.union(v.literal('server_too_old'), v.literal('backend_older'))),
	}),
	accepts: v.object({ ...imapServerReportFields, reason: v.optional(v.string()) }),
});

/** LIST: one row per folder, with the role and counters `* LIST` / `STATUS` need. */
export const listFolders = defineEndpoint({
	path: 'mail/imap/session:listFolders',
	kind: 'query',
	args: { mailboxId: v.id('mailboxes') },
	returns: v.array(
		v.object({
			_id: v.id('mailFolders'),
			name: v.string(),
			role: v.optional(folderRoleValidator),
			parentId: v.optional(v.id('mailFolders')),
			uidValidity: v.number(),
			uidNext: v.number(),
			highestModseq: v.number(),
			totalCount: v.number(),
			unseenCount: v.number(),
			subscribed: v.boolean(),
		})
	),
});

/** SELECT / EXAMINE: folder metadata plus the first unseen message's UID. */
export const selectFolder = defineEndpoint({
	path: 'mail/imap/session:selectFolder',
	kind: 'query',
	args: { folderId: v.id('mailFolders') },
	returns: v.union(
		v.null(),
		v.object({
			folder: v.object({
				_id: v.id('mailFolders'),
				name: v.string(),
				role: v.optional(folderRoleValidator),
				uidValidity: v.number(),
				uidNext: v.number(),
				highestModseq: v.number(),
				totalCount: v.number(),
				unseenCount: v.number(),
			}),
			firstUnseenUid: v.optional(v.number()),
		})
	),
});

/** The counters IDLE polls to notice a change. */
export const peekFolderModseq = defineEndpoint({
	path: 'mail/imap/session:peekFolderModseq',
	kind: 'query',
	args: { folderId: v.id('mailFolders') },
	returns: v.union(
		v.null(),
		v.object({
			highestModseq: v.number(),
			uidNext: v.number(),
			totalCount: v.number(),
			unseenCount: v.number(),
		})
	),
});

/** The system folder with an IMAP role (`\Sent`, `\Trash` …), if the mailbox has one. */
export const resolveSpecialFolder = defineEndpoint({
	path: 'mail/imap/session:resolveSpecialFolder',
	kind: 'query',
	args: { mailboxId: v.id('mailboxes'), role: folderRoleValidator },
	returns: v.union(v.null(), v.object({ _id: v.id('mailFolders'), name: v.string() })),
});
