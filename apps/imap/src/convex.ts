/**
 * Convex client wrapper used by the IMAP server.
 *
 * We use the HTTP transport so each connection can run its own client
 * with admin auth. For IDLE we also support a long-lived subscription
 * via the websocket client, but P4 (read-only) only needs HTTP.
 */

import { ConvexHttpClient } from 'convex/browser';
import type { ImapConfig } from './config.js';

export type ConvexClient = ConvexHttpClient;

/**
 * `setAdminAuth` is a real runtime method on `ConvexHttpClient` for
 * authenticating with a deploy admin key, but Convex deliberately omits it
 * from the public type surface. We narrow to it explicitly here.
 */
interface AdminAuthClient {
	setAdminAuth(token: string): void;
}

export function createConvexClient(config: ImapConfig): ConvexClient {
	const client = new ConvexHttpClient(config.convexUrl);
	(client as unknown as AdminAuthClient).setAdminAuth(config.convexAdminKey);
	return client;
}

/**
 * Untyped reference to a Convex internal function. The IMAP server stays
 * loosely typed against the Convex API surface so this workspace doesn't
 * need to import the auto-generated `_generated/api.d.ts` from apps/api
 * (which would create a circular dev dependency).
 */
export type FnRef = string;

// Convex addresses functions by their module path (directory + filename,
// minus the .ts), so functions in convex/mail/imap/session.ts and
// convex/mail/appPasswords.ts are referenced as `mail/imap/session:fn` /
// `mail/appPasswords:fn` — NOT the flat `mailImap:` / `mailAppPasswords:`
// names these once used. Because these strings are cast `as never` they
// bypass typecheck, so they must be kept in sync with apps/api by hand.
export const fn = {
	verifyAppPassword: 'mail/appPasswords:verify' as FnRef,
	touchAppPassword: 'mail/appPasswords:touch' as FnRef,
	listFolders: 'mail/imap/session:listFolders' as FnRef,
	selectFolder: 'mail/imap/session:selectFolder' as FnRef,
	fetchEnvelopes: 'mail/imap/fetch:fetchEnvelopes' as FnRef,
	listFolderUids: 'mail/imap/fetch:listFolderUids' as FnRef,
	fetchRawStorageId: 'mail/imap/fetch:fetchRawStorageId' as FnRef,
	peekFolderModseq: 'mail/imap/session:peekFolderModseq' as FnRef,
	resolveSpecialFolder: 'mail/imap/session:resolveSpecialFolder' as FnRef,
	// P5 — write commands
	storeFlags: 'mail/imap/flags:storeFlags' as FnRef,
	copyMessages: 'mail/imap/move:copyMessages' as FnRef,
	moveMessages: 'mail/imap/move:moveMessages' as FnRef,
	expungeFolder: 'mail/imap/move:expungeFolder' as FnRef,
	appendMessage: 'mail/imap/append:appendMessage' as FnRef,
	resolveMessageIdsByUid: 'mail/imap/fetch:resolveMessageIdsByUid' as FnRef,
	getRawStorageUrl: 'mail/imap/fetch:getRawStorageUrl' as FnRef,
	generateUploadUrl: 'mail/imap/append:generateRawUploadUrl' as FnRef,
};
