/**
 * Convex client wrapper for the mail-sync worker.
 *
 * Uses the HTTP transport with admin auth (like apps/imap). Functions are
 * referenced by untyped string so this workspace doesn't import apps/api's
 * generated `_generated/api.d.ts` (which would create a circular dev dep).
 */

import { createAdminConvexClient } from '@owlat/shared';
import { ConvexHttpClient } from 'convex/browser';
import type { MailSyncConfig } from './config.js';

export type ConvexClient = ConvexHttpClient;

export function createConvexClient(config: MailSyncConfig): ConvexClient {
	return createAdminConvexClient(ConvexHttpClient, config.convexUrl, config.convexAdminKey);
}

export type FnRef = string;

/** Internal Convex functions the worker calls (admin-key authenticated). */
export const fn = {
	// Decrypts + returns plaintext IMAP/SMTP creds (internalAction).
	getCredentialsForWorker: 'mail/external/accountsActions:getCredentialsForWorker' as FnRef,
	// Accounts to hold connections for (internalQuery).
	listConnectableAccounts: 'mail/external/accounts:listConnectableAccounts' as FnRef,
	// Connection/sync status write-back (internalMutation).
	setSyncStatus: 'mail/external/accounts:setSyncStatus' as FnRef,
	// Raw-bytes inbound ingestion (internalAction; stores blob + inserts).
	ingestExternalRaw: 'mail/external/delivery:ingestExternalRaw' as FnRef,
	// Resume cursors per folder (internalQuery).
	getSyncState: 'mail/external/delivery:getSyncState' as FnRef,
	// Record remote→local folder mapping + initial high-water UID (internalMutation).
	recordFolderMapping: 'mail/external/delivery:recordFolderMapping' as FnRef,

	// ── Deliverability seed-probe sweep (gate 5) ─────────────────────────
	// Seed mailboxes with outstanding probes (internalQuery).
	listSeedProbeWork: 'analytics/seedProbePoller:listSeedProbeWork' as FnRef,
	// Report one probe's folder + run the planned hygiene (internalMutation).
	recordSeedProbeClassification: 'analytics/seedPlacement:recordSeedProbeClassification' as FnRef,

	// ── Historical backfill (migration) ──────────────────────────────────
	// Whether a migration is importing + each folder's backfill cursor (internalQuery).
	getBackfillWork: 'mail/migrationBackfill:getBackfillWork' as FnRef,
	// Snapshot a folder's high-water UID + count; returns the start cursor (internalMutation).
	initFolderBackfill: 'mail/migrationBackfill:initFolderBackfill' as FnRef,
	// Persist one descending backfill batch's progress (internalMutation).
	recordBackfillProgress: 'mail/migrationBackfill:recordBackfillProgress' as FnRef,
	// Signal "all folders backfilled" → hand off to AI indexing / finalize (internalMutation).
	completeBackfillImport: 'mail/migrationBackfill:completeBackfillImport' as FnRef,
	// Signal "backfill threw and won't self-heal" → migration → failed (internalMutation).
	markImportFailed: 'mail/migrationBackfill:markImportFailed' as FnRef,
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
	/**
	 * OAuth bearer access token for the user's SMTP submission endpoint (Gmail /
	 * Microsoft). When present, the outbound relay authenticates with SASL XOAUTH2
	 * instead of a password. Acquisition and refresh of this token are owned by the
	 * external-accounts OAuth feature (`mail/external/googleOAuth*` in apps/api) —
	 * this worker only forwards whatever token the backend handed it;
	 * `smtpPassword` is ignored on the XOAUTH2 path.
	 */
	smtpAccessToken?: string;
	/**
	 * The IMAP twin of {@link WorkerCredentials.smtpAccessToken}. Present (with
	 * both password fields empty) on an `authMethod: 'oauth2'` account, where
	 * ImapFlow authenticates with `AUTHENTICATE XOAUTH2` instead of LOGIN. Minted
	 * per credential fetch by the backend from the stored refresh token, so it is
	 * already live and this worker never refreshes or persists it.
	 */
	imapAccessToken?: string;
}

/** Why a credential fetch came back empty. Mirrors the backend's union. */
export type CredentialsUnavailableReason =
	| 'missing'
	| 'disconnected'
	| 'auth_revoked'
	| 'refresh_failed';

/**
 * What `getCredentialsForWorker` answers with.
 *
 * Mirrors `WorkerCredentialsResult` in
 * `apps/api/convex/mail/external/accountsActions.ts`. The discriminant exists so
 * this worker can tell the TERMINAL outcomes apart from the retryable ones:
 * `auth_revoked` means the backend has already marked the account `auth_error`
 * with the message that tells the user to reconnect, and `disconnected` means
 * the member ended the connection and the password is gone. Neither can be
 * changed by retrying, and in both cases the backend has already written the
 * status that is true.
 */
export type WorkerCredentialsResult =
	| { kind: 'credentials'; credentials: WorkerCredentials }
	| { kind: 'unavailable'; reason: CredentialsUnavailableReason };

/**
 * A credential fetch that produced no credentials, carrying WHY so the caller
 * can decide between backing off and giving up.
 */
export class CredentialsUnavailableError extends Error {
	constructor(readonly reason: CredentialsUnavailableReason) {
		super(`credentials unavailable (${reason})`);
		this.name = 'CredentialsUnavailableError';
	}

	/** Terminal: only the user reconnecting the account can change the answer. */
	get isTerminal(): boolean {
		return this.reason === 'auth_revoked' || this.reason === 'disconnected';
	}
}

/**
 * Fetch one account's plaintext credentials. The single call site for the
 * untyped Convex reference, so the connect loop, the /send route and the seed
 * sweep all read the same shape.
 */
export async function fetchWorkerCredentials(
	convex: ConvexClient,
	accountId: string
): Promise<WorkerCredentialsResult> {
	const result = (await convex.action(
		fn.getCredentialsForWorker as never,
		{
			accountId,
		} as never
	)) as WorkerCredentialsResult | WorkerCredentials | null;
	// A deployment mid-rollout (older backend, newer worker) still speaks the
	// pre-OAuth shape: `null` on a miss, a bare credential bundle on success. Map
	// both onto the typed result so a split-version stack keeps syncing.
	if (result === null) return { kind: 'unavailable', reason: 'missing' };
	if (!('kind' in result)) return { kind: 'credentials', credentials: result };
	return result;
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
