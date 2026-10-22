/**
 * How each write-back and remote-sync wire fixture is produced: the call the
 * mail-sync worker makes, against the seeded deployment
 * (`workerWireMailSync.testlib.ts`).
 */

import { MAIL_SYNC_WIRE_IDS as M } from '@owlat/worker-protocol/wireFixtures';
import { expect } from 'vitest';
import { internal } from '../../_generated/api';
import type { MailSyncDrive } from './workerWireMailSyncDrives.testlib';
import type { MailSyncWireWorld } from './workerWireMailSync.testlib';

/** Bind a placeholder to a value the deployment minted, after checking it is a string. */
function bindMinted(w: MailSyncWireWorld, placeholder: string, value: unknown): void {
	expect(typeof value).toBe('string');
	w.ids[placeholder] = value as string;
}

export const MAIL_SYNC_REMOTE_DRIVES = {
	listDueRemoteOps: {
		'a move and a flag change': (w) =>
			w.t.query(internal.mail.external.remoteOps.listDueRemoteOps, { accountId: w.accountId }),
		'not writing back': (w) =>
			w.t.query(internal.mail.external.remoteOps.listDueRemoteOps, {
				accountId: w.oauthAccountId,
			}),
	},
	settleRemoteOps: {
		settled: (w) =>
			w.t.mutation(internal.mail.external.remoteOps.settleRemoteOps, {
				results: [
					{ opId: w.ops.move, outcome: 'done' },
					{ opId: w.ops.flags, outcome: 'failed', error: 'NO [TRYCREATE] Mailbox missing' },
				],
			}),
	},
	recordRemoteFolderRename: {
		recorded: (w) =>
			w.t.mutation(internal.mail.external.remoteFolderRename.recordRemoteFolderRename, {
				opId: w.ops.rename,
				remoteName: 'Clients',
				delimiter: '/',
			}),
	},
	listQueuedFolderRenames: {
		'one queued': async (w) => {
			const page = await w.t.query(
				internal.mail.external.remoteFolderRename.listQueuedFolderRenames,
				{ accountId: w.accountId, cursor: null }
			);
			bindMinted(w, M.renamesCursor, page.continueCursor);
			return page;
		},
		'not writing back': (w) =>
			w.t.query(internal.mail.external.remoteFolderRename.listQueuedFolderRenames, {
				accountId: w.oauthAccountId,
				cursor: null,
			}),
	},
	getSyncSettings: {
		'two-way, aligned': (w) =>
			w.t.query(internal.mail.external.remoteState.getSyncSettings, { accountId: w.accountId }),
		'new mail only': (w) =>
			w.t.query(internal.mail.external.remoteState.getSyncSettings, {
				accountId: w.oauthAccountId,
			}),
	},
	listLocalMessages: {
		'one page': async (w) => {
			const page = await w.t.query(internal.mail.external.remoteState.listLocalMessages, {
				accountId: w.accountId,
				paginationOpts: { numItems: 50, cursor: null },
			});
			bindMinted(w, M.localCursor, page.continueCursor);
			return page;
		},
		'more to come': async (w) => {
			const page = await w.t.query(internal.mail.external.remoteState.listLocalMessages, {
				accountId: w.accountId,
				paginationOpts: { numItems: 2, cursor: null },
			});
			bindMinted(w, M.localPartialCursor, page.continueCursor);
			return page;
		},
		'not writing back': (w) =>
			w.t.query(internal.mail.external.remoteState.listLocalMessages, {
				accountId: w.oauthAccountId,
				paginationOpts: { numItems: 50, cursor: null },
			}),
	},
	lookupLocalMessages: {
		found: (w) =>
			w.t.query(internal.mail.external.remoteState.lookupLocalMessages, {
				accountId: w.accountId,
				messageIds: ['reminder-2@example.com'],
			}),
	},
	applyRemoteObservations: {
		'pulled a flag': async (w) => {
			// A message with a write-back in flight is left alone, so the queue goes first.
			await w.t.run(async (ctx) => {
				for (const id of Object.values(w.ops)) await ctx.db.delete(id);
			});
			return await w.t.mutation(internal.mail.external.remoteState.applyRemoteObservations, {
				accountId: w.accountId,
				observations: [
					{
						messageId: 'reminder-2@example.com',
						flags: { seen: true, flagged: false, answered: false },
						sightings: [{ remoteName: 'Archive', uidValidity: 78, uid: 39 }],
					},
				],
			});
		},
	},
	markFullSyncAligned: {
		aligned: (w) =>
			w.t.mutation(internal.mail.external.remoteState.markFullSyncAligned, {
				accountId: w.accountId,
			}),
	},
	forgetRemoteFolders: {
		'forgot one': (w) =>
			w.t.mutation(internal.mail.external.remoteState.forgetRemoteFolders, {
				accountId: w.accountId,
				listed: ['INBOX'],
			}),
	},
} satisfies Record<string, Record<string, MailSyncDrive>>;
