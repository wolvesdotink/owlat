/**
 * Convex client wrapper for the mail-sync worker.
 *
 * Uses the HTTP transport with admin auth (like apps/imap). Functions are
 * referenced through typed `makeFunctionReference` declarations (see `fn`
 * below) so this workspace doesn't import apps/api's generated
 * `_generated/api.d.ts` (which would create a circular dev dep).
 */

import { createAdminConvexClient } from '@owlat/shared';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import type { MailSyncConfig } from './config.js';
import type { FolderRole } from './folders.js';
import type { SeedProbeDeps, SeedProbeWorkPage } from './seedProbes.js';

export type ConvexClient = ConvexHttpClient;

export function createConvexClient(config: MailSyncConfig): ConvexClient {
	return createAdminConvexClient(ConvexHttpClient, config.convexUrl, config.convexAdminKey);
}

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
 * Fetch one account's plaintext credentials. The single call site for
 * `getCredentialsForWorker`, so the connect loop, the /send route and the seed
 * sweep all read the same shape.
 */
export async function fetchWorkerCredentials(
	convex: ConvexClient,
	accountId: string
): Promise<WorkerCredentialsResult> {
	const result = await convex.action(fn.getCredentialsForWorker, { accountId });
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
	forwardIngestFailures: Array<{ uid: number; attempts: number }>;
	forwardIngestFailureCount: number;
}

/** Backfill work for an account from getBackfillWork. */
export interface BackfillWork {
	isActive: boolean;
	/** The importing migration this run's progress must be attributed to (null when inactive). */
	migrationId: string | null;
	/** Epoch ms a throttle-paused import may run again. Persisted, so a worker
	 * restart honours a pause it did not itself decide. Absent when not paused. */
	resumesAt?: number;
}

/**
 * What the server did with one message. Mirrors `ExternalIngestOutcome` in
 * `apps/api/convex/mail/external/delivery.ts`.
 *
 * `duplicate` means the message is ALREADY in the mailbox (Gmail's "All Mail"
 * repeats every other folder), so it counts as landed; `no_target` means the
 * account/mailbox/folder it belongs in is gone and nothing was stored. Reading
 * this is what stops a walk that stored nothing from reporting a full import.
 */
export type IngestOutcome = { messageId: string } | { skipped: 'duplicate' | 'no_target' };

/** A forward-sync miss as persisted: retry it, or give up after `attempts`. */
export interface ForwardIngestFailureResult {
	retry: boolean;
	attempts: number;
}

/** What `pauseImportForThrottle` did with the migration. */
export interface ThrottlePauseResult {
	outcome: 'paused' | 'failed' | 'ignored';
}

/** One attachment's metadata, as `ingestExternalRaw` stores it. */
type IngestAttachment = {
	filename: string;
	contentType: string;
	size: number;
	contentId?: string;
	partIndex: string;
};

type IngestExternalRawArgs = {
	accountId: string;
	folderRole: FolderRole;
	remoteName: string;
	remoteUid: number;
	remoteUidValidity: number;
	/** Sealed raw `.eml`, already stored by `/mail-sync/raw-message`. */
	rawStorageId: string;
	rawSize: number;
	/** First 64 KiB of the raw message, base64 — the header block. */
	headerBlockBase64: string;
	from: string;
	to: string[];
	cc: string[];
	bcc: string[];
	replyTo?: string;
	subject: string;
	textBodyInline?: string;
	htmlBodyInline?: string;
	messageId: string;
	inReplyTo?: string;
	references?: string;
	receivedAt: number;
	attachments: IngestAttachment[];
	flagSeen?: boolean;
	flagFlagged?: boolean;
	origin?: 'sync' | 'backfill';
};

type RecordSeedProbeClassification = SeedProbeDeps['recordClassification'];

/**
 * Typed references to the internal Convex functions the worker calls
 * (admin-key authenticated).
 *
 * The kind, argument and result types are declared by hand because apps/api's
 * generated types are not imported: a wrong argument or a query called as a
 * mutation is a type error at the call site, but the declarations themselves
 * must be kept in step with apps/api. The convexRefs test checks each path and
 * kind against the Convex source.
 *
 * Keep every path a single-quoted literal inside its makeFunctionReference
 * call: apps/api/scripts/check-entry-wiring.ts credits callers by it.
 */
export const fn = {
	/**
	 * Decrypts + returns plaintext IMAP/SMTP creds. The result also admits the
	 * pre-OAuth shape (`null` or a bare bundle) an older backend still answers
	 * with during a rolling deploy; `fetchWorkerCredentials` maps both.
	 */
	getCredentialsForWorker: makeFunctionReference<
		'action',
		{ accountId: string },
		WorkerCredentialsResult | WorkerCredentials | null
	>('mail/external/accountsActions:getCredentialsForWorker'),
	// Accounts to hold connections for.
	listConnectableAccounts: makeFunctionReference<
		'query',
		Record<string, never>,
		ConnectableAccount[]
	>('mail/external/accounts:listConnectableAccounts'),
	// Connection/sync status write-back.
	setSyncStatus: makeFunctionReference<
		'mutation',
		{
			accountId: string;
			status: 'pending' | 'connected' | 'auth_error' | 'error' | 'disconnected';
			lastError?: string;
			markSynced?: boolean;
		},
		null
	>('mail/external/accounts:setSyncStatus'),
	// Raw-bytes inbound ingestion (stores blob + inserts).
	ingestExternalRaw: makeFunctionReference<'action', IngestExternalRawArgs, IngestOutcome>(
		'mail/external/delivery:ingestExternalRaw'
	),
	// Resume cursors per folder.
	getSyncState: makeFunctionReference<'query', { accountId: string }, FolderCursor[]>(
		'mail/external/delivery:getSyncState'
	),
	// Record remote→local folder mapping + initial high-water UID.
	recordFolderMapping: makeFunctionReference<
		'mutation',
		{
			accountId: string;
			folderRole: FolderRole;
			remoteName: string;
			remoteUidValidity: number;
			initialLastSeenUid: number;
		},
		null
	>('mail/external/delivery:recordFolderMapping'),
	recordForwardIngestFailure: makeFunctionReference<
		'mutation',
		{ accountId: string; remoteName: string; remoteUidValidity: number; uid: number },
		ForwardIngestFailureResult
	>('mail/external/delivery:recordForwardIngestFailure'),

	// ── Deliverability seed-probe sweep (gate 5) ─────────────────────────
	// Seed mailboxes with outstanding probes.
	listSeedProbeWork: makeFunctionReference<
		'query',
		{ now: number; cursor?: string | null },
		SeedProbeWorkPage
	>('analytics/seedProbePoller:listSeedProbeWork'),
	// Report one probe's folder + run the planned hygiene.
	recordSeedProbeClassification: makeFunctionReference<
		'mutation',
		Parameters<RecordSeedProbeClassification>[0],
		Awaited<ReturnType<RecordSeedProbeClassification>>
	>('analytics/seedPlacement:recordSeedProbeClassification'),

	// ── Historical backfill (migration) ──────────────────────────────────
	// Whether a migration is importing + each folder's backfill cursor.
	getBackfillWork: makeFunctionReference<'query', { accountId: string }, BackfillWork>(
		'mail/migrationBackfill:getBackfillWork'
	),
	// Snapshot a folder's high-water UID + count; returns the start cursor.
	initFolderBackfill: makeFunctionReference<
		'mutation',
		{
			accountId: string;
			migrationId: string;
			remoteName: string;
			ceilingUid: number;
			messageCount: number;
		},
		{ startCursor: number } | null
	>('mail/migrationBackfill:initFolderBackfill'),
	// Which of a batch's Message-IDs the mailbox already holds, so the walk can
	// skip them WITHOUT downloading their bodies.
	findKnownMessageIds: makeFunctionReference<
		'query',
		{ accountId: string; messageIds: string[] },
		string[]
	>('mail/migrationBackfill:findKnownMessageIds'),
	// Persist one descending backfill batch's progress.
	recordBackfillProgress: makeFunctionReference<
		'mutation',
		{
			accountId: string;
			migrationId: string;
			remoteName: string;
			newCursor: number;
			importedDelta: number;
			failedDelta: number;
		},
		{ stillImporting: boolean }
	>('mail/migrationBackfill:recordBackfillProgress'),
	// Signal "all folders backfilled" → hand off to AI indexing / finalize.
	completeBackfillImport: makeFunctionReference<'mutation', { migrationId: string }, null>(
		'mail/migrationBackfill:completeBackfillImport'
	),
	// Signal "backfill threw and won't self-heal" → migration → failed.
	markImportFailed: makeFunctionReference<
		'mutation',
		{ migrationId: string; errorMessage?: string },
		null
	>('mail/migrationBackfill:markImportFailed'),
	// Signal "the provider's budget is spent" → hold the migration until it
	// resets instead of failing it.
	pauseImportForThrottle: makeFunctionReference<
		'mutation',
		{ migrationId: string; resumeAt: number; reason?: string },
		ThrottlePauseResult
	>('mail/migrationBackfill:pauseImportForThrottle'),
};
