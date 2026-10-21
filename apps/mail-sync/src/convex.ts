/**
 * Convex client wrapper for the mail-sync worker.
 *
 * Uses the HTTP transport with admin auth (like apps/imap). Functions are
 * referenced through the `fn` table below, built from the mail-sync wire
 * contract (`@owlat/worker-protocol/mailSync`), so this workspace doesn't
 * import apps/api's generated `_generated/api.d.ts` (which would create a
 * circular dev dep).
 */

import { createAdminConvexClient } from '@owlat/shared';
import type { EndpointResult, EndpointReturns } from '@owlat/worker-protocol';
import {
	createCheckedClient,
	workerReferences,
	type CheckedConvexClient,
	type ConvexTransport,
} from '@owlat/worker-protocol/client';
import {
	MAIL_SYNC_ENDPOINTS,
	type credentialsUnavailableReasonValidator,
	type getBackfillWork,
	type getCredentialsForWorker,
	type getSyncState,
	type ingestExternalRaw,
	type listConnectableAccounts,
	type workerCredentialsValidator,
} from '@owlat/worker-protocol/mailSync';
import { ConvexHttpClient } from 'convex/browser';
import { getFunctionName, type FunctionReference } from 'convex/server';
import type { Infer } from 'convex/values';
import type { MailSyncConfig } from './config.js';

/**
 * The client the worker calls Convex through: `ConvexHttpClient`'s surface,
 * with each answer checked against the mail-sync wire contract before any
 * caller reads it.
 */
export type ConvexClient = CheckedConvexClient;

export function createConvexClient(config: MailSyncConfig): ConvexClient {
	return checkedConvexClient(
		createAdminConvexClient(ConvexHttpClient, config.convexUrl, config.convexAdminKey)
	);
}

/** The mail-sync contract's checks over any transport: what `createConvexClient` ships. */
export function checkedConvexClient(transport: ConvexTransport): ConvexClient {
	return createCheckedClient(transport, MAIL_SYNC_ENDPOINTS);
}

/**
 * Plaintext credential bundle returned by getCredentialsForWorker.
 *
 * On an `oauth2` account (Gmail / Microsoft) `imapAccessToken` and
 * `smtpAccessToken` stand in for the passwords: ImapFlow authenticates with
 * `AUTHENTICATE XOAUTH2` and the outbound relay with SASL XOAUTH2. The backend
 * mints them from the stored refresh token (and reuses one until a minute before
 * it expires), so they are already live and this worker never refreshes or
 * persists them.
 */
export type WorkerCredentials = Infer<typeof workerCredentialsValidator>;

/** Why a credential fetch came back empty. */
export type CredentialsUnavailableReason = Infer<typeof credentialsUnavailableReasonValidator>;

/**
 * What `getCredentialsForWorker` answers with. The discriminant exists so this
 * worker can tell the TERMINAL outcomes apart from the retryable ones:
 * `auth_revoked` means the backend has already marked the account `auth_error`
 * with the message that tells the user to reconnect, and `disconnected` means
 * the member ended the connection and the password is gone. Neither can be
 * changed by retrying, and in both cases the backend has already written the
 * status that is true.
 */
export type WorkerCredentialsResult = EndpointReturns<typeof getCredentialsForWorker>;

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
	if (result.kind === 'credentials' || result.kind === 'unavailable') return result;
	const { kind: _legacy, ...credentials } = result;
	return { kind: 'credentials', credentials };
}

/**
 * Whether `err` is the backend answering that it has no function `ref`: a
 * backend older than this worker, mid-rollout. Any other failure, a network
 * error or a 503 included, is not.
 */
export function isMissingFunction(
	err: unknown,
	ref: FunctionReference<'query' | 'mutation' | 'action', 'public' | 'internal'>
): boolean {
	const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
	const named = /Could not find (?:public )?function for '([^']+)'/.exec(message)?.[1];
	// The backend may name the module with its file extension.
	return named?.replace(/\.js(?=:|$)/, '') === getFunctionName(ref);
}

/** Summary row from listConnectableAccounts. */
export type ConnectableAccount = EndpointResult<typeof listConnectableAccounts>[number];

/** Folder resume cursor from getSyncState. */
export type FolderCursor = EndpointResult<typeof getSyncState>[number];

/**
 * Backfill work for an account from getBackfillWork: `migrationId` is the
 * importing migration this run's progress must be attributed to, and
 * `resumesAt` the epoch ms a throttle-paused import may run again (persisted,
 * so a worker restart honours a pause it did not itself decide).
 */
export type BackfillWork = EndpointResult<typeof getBackfillWork>;

/**
 * What the server did with one message. `duplicate` means the message is
 * ALREADY in the mailbox (Gmail's "All Mail" repeats every other folder), so it
 * counts as landed; `no_target` means the account/mailbox/folder it belongs in
 * is gone and nothing was stored. Reading this is what stops a walk that stored
 * nothing from reporting a full import.
 */
export type IngestOutcome = EndpointResult<typeof ingestExternalRaw>;

/**
 * Typed references to the internal Convex functions the worker calls
 * (admin-key authenticated), built from the mail-sync wire contract: their
 * paths, kinds, argument and result types all come from
 * `@owlat/worker-protocol/mailSync`, the same declarations apps/api registers
 * as each function's `args` and `returns`. `getCredentialsForWorker`'s result
 * also admits the pre-OAuth shape an older backend still answers with during a
 * rolling deploy; `fetchWorkerCredentials` maps it. The convexRefs test checks
 * each path and kind against the Convex source.
 */
export const fn = workerReferences(MAIL_SYNC_ENDPOINTS);
