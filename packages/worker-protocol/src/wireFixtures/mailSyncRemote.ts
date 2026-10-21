/**
 * The mail-sync fixtures for write-back and remote change sync, split out of
 * `mailSync.ts` to keep each file readable. Same seeded deployment.
 */

import type {
	applyRemoteObservations,
	forgetRemoteFolders,
	getSyncSettings,
	listDueRemoteOps,
	listLocalMessages,
	listQueuedFolderRenames,
	lookupLocalMessages,
	markFullSyncAligned,
	recordRemoteFolderRename,
	settleRemoteOps,
} from '../mailSync/index';
import { MAIL_SYNC_WIRE_IDS as M } from './mailSyncIds';
import type { WireFixtures } from './types';

/** Message 1 as the reconcile compares it: in INBOX, where the provider was last seen holding it. */
const LOCAL_ROW_1 = {
	messageId: 'quarterly-1@example.com',
	remoteName: 'INBOX',
	role: 'inbox',
	flags: { seen: true, flagged: true, answered: false },
	sighting: { remoteName: 'INBOX', uidValidity: 77, uid: 101 },
} as const;

/** Message 2: in Archive, never seen at the provider. */
const LOCAL_ROW_2 = {
	messageId: 'reminder-2@example.com',
	remoteName: 'Archive',
	role: 'archive',
	flags: { seen: false, flagged: false, answered: false },
	sighting: null,
} as const;

/** A Sent copy Owlat wrote, in a folder with no remote mapping. */
const LOCAL_ROW_3 = {
	messageId: 'sent-3@owlat.example',
	remoteName: null,
	role: 'sent',
	flags: { seen: true, flagged: false, answered: false },
	sighting: null,
} as const;

type RemoteEndpoints = {
	listDueRemoteOps: typeof listDueRemoteOps;
	settleRemoteOps: typeof settleRemoteOps;
	recordRemoteFolderRename: typeof recordRemoteFolderRename;
	listQueuedFolderRenames: typeof listQueuedFolderRenames;
	getSyncSettings: typeof getSyncSettings;
	listLocalMessages: typeof listLocalMessages;
	lookupLocalMessages: typeof lookupLocalMessages;
	applyRemoteObservations: typeof applyRemoteObservations;
	markFullSyncAligned: typeof markFullSyncAligned;
	forgetRemoteFolders: typeof forgetRemoteFolders;
};

export const MAIL_SYNC_REMOTE_WIRE_FIXTURES = {
	listDueRemoteOps: [
		{
			name: 'a move and a flag change',
			value: [
				{
					opId: M.moveOp,
					kind: 'move',
					rfc822MessageId: 'quarterly-1@example.com',
					source: { remote: 'INBOX' },
					target: { role: 'archive' },
					attempts: 0,
				},
				{
					opId: M.flagsOp,
					kind: 'flags',
					rfc822MessageId: 'reminder-2@example.com',
					source: { remote: 'Archive' },
					flags: { seen: true, flagged: false },
					attempts: 1,
				},
			],
		},
		{ name: 'not writing back', value: [] },
	],
	settleRemoteOps: [{ name: 'settled', value: null }],
	recordRemoteFolderRename: [{ name: 'recorded', value: null }],
	listQueuedFolderRenames: [
		{
			name: 'one queued',
			value: {
				page: [
					{
						opId: M.renameOp,
						kind: 'renameFolder',
						source: { remote: 'Projects' },
						target: { path: ['Clients'] },
						attempts: 0,
					},
				],
				isDone: true,
				continueCursor: M.renamesCursor,
			},
		},
		{ name: 'not writing back', value: { page: [], isDone: true, continueCursor: '' } },
	],
	getSyncSettings: [
		{ name: 'two-way, aligned', value: { mode: 'full', isAligned: true } },
		{ name: 'new mail only', value: { mode: 'incoming', isAligned: false } },
	],
	listLocalMessages: [
		{
			name: 'one page',
			value: {
				page: [LOCAL_ROW_1, LOCAL_ROW_2, LOCAL_ROW_3],
				isDone: true,
				continueCursor: M.localCursor,
			},
		},
		{ name: 'not writing back', value: { page: [], isDone: true, continueCursor: '' } },
	],
	lookupLocalMessages: [{ name: 'found', value: [LOCAL_ROW_2] }],
	applyRemoteObservations: [{ name: 'pulled a flag', value: { pulled: 1, pushed: 0 } }],
	markFullSyncAligned: [{ name: 'aligned', value: null }],
	forgetRemoteFolders: [{ name: 'forgot one', value: { forgotten: 1 } }],
} satisfies WireFixtures<RemoteEndpoints>;
