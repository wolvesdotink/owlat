/**
 * Convex client wrapper for the mail-sync worker.
 *
 * Uses the HTTP transport with admin auth (like apps/imap). Functions are
 * referenced by untyped string so this workspace doesn't import apps/api's
 * generated `_generated/api.d.ts` (which would create a circular dev dep).
 */

import { ConvexHttpClient } from 'convex/browser';
import type { MailSyncConfig } from './config.js';

export type ConvexClient = ConvexHttpClient;

export function createConvexClient(config: MailSyncConfig): ConvexClient {
	const client = new ConvexHttpClient(config.convexUrl);
	// `setAdminAuth` is a real runtime method on ConvexHttpClient but is omitted
	// from the published public type — cast to reach it (apps/imap does the same).
	(client as unknown as { setAdminAuth(key: string): void }).setAdminAuth(config.convexAdminKey);
	return client;
}

export type FnRef = string;

/** Internal Convex functions the worker calls (admin-key authenticated). */
export const fn = {
	// Decrypts + returns plaintext IMAP/SMTP creds (internalAction).
	getCredentialsForWorker: 'mail/externalAccountsActions:getCredentialsForWorker' as FnRef,
	// Accounts to hold connections for (internalQuery).
	listConnectableAccounts: 'mail/externalAccounts:listConnectableAccounts' as FnRef,
	// Connection/sync status write-back (internalMutation).
	setSyncStatus: 'mail/externalAccounts:setSyncStatus' as FnRef,
	// Raw-bytes inbound ingestion (internalAction; stores blob + inserts).
	ingestExternalRaw: 'mail/externalDelivery:ingestExternalRaw' as FnRef,
	// Resume cursors per folder (internalQuery).
	getSyncState: 'mail/externalDelivery:getSyncState' as FnRef,
	// Record remote→local folder mapping + initial high-water UID (internalMutation).
	recordFolderMapping: 'mail/externalDelivery:recordFolderMapping' as FnRef,

	// ── Historical backfill (migration) ──────────────────────────────────
	// Whether a migration is importing + each folder's backfill cursor (internalQuery).
	getBackfillWork: 'mail/migration:getBackfillWork' as FnRef,
	// Snapshot a folder's high-water UID + count; returns the start cursor (internalMutation).
	initFolderBackfill: 'mail/migration:initFolderBackfill' as FnRef,
	// Persist one descending backfill batch's progress (internalMutation).
	recordBackfillProgress: 'mail/migration:recordBackfillProgress' as FnRef,
	// Signal "all folders backfilled" → hand off to AI indexing / finalize (internalMutation).
	completeBackfillImport: 'mail/migration:completeBackfillImport' as FnRef,
	// Signal "backfill threw and won't self-heal" → migration → failed (internalMutation).
	markImportFailed: 'mail/migration:markImportFailed' as FnRef,
};

/** Plaintext credential bundle returned by getCredentialsForWorker. */
export interface WorkerCredentials {
	imapHost: string;
	imapPort: number;
	isImapSecure: boolean;
	smtpHost: string;
	smtpPort: number;
	isSmtpSecure: boolean;
	imapUsername: string;
	smtpUsername: string;
	imapPassword: string;
	smtpPassword: string;
}

/** Summary row from listConnectableAccounts. */
export interface ConnectableAccount {
	accountId: string;
	mailboxId: string;
	imapHost: string;
	imapPort: number;
	isImapSecure: boolean;
	imapUsername: string;
	status: 'pending' | 'connected' | 'error';
}

/** Folder resume cursor from getSyncState. */
export interface FolderCursor {
	remoteName: string;
	remoteUidValidity: number;
	lastSeenUid: number;
	folderId: string;
}

/** Backfill work for an account from getBackfillWork. */
export interface BackfillWork {
	isActive: boolean;
	/** The importing migration this run's progress must be attributed to (null when inactive). */
	migrationId: string | null;
}
