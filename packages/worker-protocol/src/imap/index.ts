/**
 * Every Convex function the IMAP server (apps/imap) calls, by the name its `fn`
 * table uses. apps/api registers each one's `args` and `returns` from here;
 * apps/imap builds its function references and its result checks from here.
 */

import {
	folderMembershipPage,
	fetchChangedEnvelopes,
	fetchEnvelopes,
	getRawStorageUrls,
	listFolderUidsPage,
	resolveMessageIdsByUid,
} from './fetch';
import {
	listFolders,
	peekFolderModseq,
	reportServer,
	resolveSpecialFolder,
	selectFolder,
	touchAppPassword,
	verifyAppPassword,
} from './session';
import {
	appendMessage,
	copyMessages,
	discardCopies,
	expungeFolder,
	generateUploadUrl,
	moveMessages,
	storeFlags,
} from './write';

export * from './fetch';
export * from './session';
export * from './write';

export const IMAP_ENDPOINTS = {
	verifyAppPassword,
	touchAppPassword,
	reportServer,
	listFolders,
	selectFolder,
	fetchEnvelopes,
	fetchChangedEnvelopes,
	listFolderUidsPage,
	folderMembershipPage,
	peekFolderModseq,
	resolveSpecialFolder,
	storeFlags,
	copyMessages,
	moveMessages,
	expungeFolder,
	discardCopies,
	appendMessage,
	resolveMessageIdsByUid,
	getRawStorageUrls,
	generateUploadUrl,
} as const;
