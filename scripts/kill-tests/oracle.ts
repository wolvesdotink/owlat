/**
 * What a kill test must find once the killed process has been restarted and
 * has settled. The verdicts read the Convex backend's persisted rows (Sends,
 * mailbox messages, the import and its folder cursor), plus what the world
 * observed on the wire: bodies at the receiver, webhooks the backend
 * acknowledged, the backend's answer to each ingest. Pure functions, so the
 * verdicts themselves are unit-tested, negative controls included
 * (scripts/__tests__/kill-tests-oracle.test.ts).
 */

/** A send the MTA scenario queued, and where (if anywhere) the sink pinned it. */
export interface PlannedSend {
	readonly messageId: string;
	readonly rcpt: string;
	/**
	 * `data`: killed before any body byte crossed the wire, so the send must be
	 * retried and delivered once. `dot`: killed after the receiver had the body
	 * but before its reply, so the send must end ambiguous and never be resent.
	 */
	readonly heldAt?: 'data' | 'dot';
}

export interface SinkTransactionState {
	readonly rcpts: readonly string[];
	readonly bodyReceived: boolean;
}

/** An MTA webhook as the world forwarded it, with the backend's HTTP status. */
export interface WebhookState {
	readonly event: string;
	readonly messageId: string;
	readonly backendStatus: number;
}

/** The persisted Send (`transactionalSends`), as far as the verdict reads it. */
export interface SendRowState {
	readonly providerMessageId?: string;
	readonly status: string;
	readonly errorMessage?: string;
	readonly errorCode?: string;
	readonly bounceType?: string;
	readonly bouncedAt?: number;
}

/** Webhook events after which Convex holds the Send in a terminal state. */
export const TERMINAL_EVENTS = ['sent', 'bounced', 'failed'] as const;
/** How the MTA words an ambiguous post-DATA outcome on the `failed` webhook. */
export const AMBIGUOUS_MESSAGE_PREFIX = 'Ambiguous post-DATA drop';
/** The error code Convex records for that outcome (webhooks/adapters/mtaEventParsers.ts). */
export const AMBIGUOUS_ERROR_CODE = 'ambiguous_post_data';

function acknowledgedTerminalKinds(webhooks: readonly WebhookState[], messageId: string) {
	return new Set(
		webhooks
			.filter(
				(w) =>
					w.messageId === messageId &&
					w.backendStatus >= 200 &&
					w.backendStatus < 300 &&
					(TERMINAL_EVENTS as readonly string[]).includes(w.event)
			)
			.map((w) => w.event)
	);
}

export function checkMtaRun(
	plan: readonly PlannedSend[],
	smtp: readonly SinkTransactionState[],
	webhooks: readonly WebhookState[],
	sends: readonly SendRowState[]
): string[] {
	const failures: string[] = [];
	for (const send of plan) {
		const label = `${send.messageId}${send.heldAt ? ` (killed at ${send.heldAt})` : ''}`;
		const bodies = smtp.filter((t) => t.bodyReceived && t.rcpts.includes(send.rcpt)).length;
		if (bodies !== 1) failures.push(`${label}: the receiver got ${bodies} bodies, expected 1`);
		const terminal = acknowledgedTerminalKinds(webhooks, send.messageId);
		if (terminal.size > 1) {
			failures.push(
				`${label}: contradictory terminal webhook events [${[...terminal].join(', ')}]`
			);
		}
		const rows = sends.filter((row) => row.providerMessageId === send.messageId);
		if (rows.length !== 1) {
			failures.push(`${label}: ${rows.length} Send rows carry its message id, expected 1`);
			continue;
		}
		const row = rows[0]!;
		if (send.heldAt === 'dot') {
			const ambiguous =
				row.status === 'failed' &&
				row.errorCode === AMBIGUOUS_ERROR_CODE &&
				(row.errorMessage ?? '').startsWith(AMBIGUOUS_MESSAGE_PREFIX);
			if (!ambiguous) {
				failures.push(
					`${label}: Send is '${row.status}' (${row.errorCode ?? 'no code'}: ${row.errorMessage ?? 'no message'}), expected failed as ${AMBIGUOUS_ERROR_CODE}`
				);
			}
			if (row.bounceType !== undefined || row.bouncedAt !== undefined) {
				failures.push(`${label}: Send carries a bounce, but an ambiguous drop is not one`);
			}
		} else if (row.status !== 'delivered') {
			failures.push(`${label}: Send is '${row.status}', expected delivered`);
		}
	}
	return failures;
}

/** The fixture message for `uid` carries this subject, so a stored row maps back to its UID. */
export function backfillSubject(uid: number): string {
	return `kill test backfill ${uid}`;
}

/** A persisted `mailMessages` row of the imported mailbox. */
export interface StoredMessageState {
	readonly subject: string;
	readonly rfc822MessageId: string;
}

/** One `ingestExternalRaw` call as the world forwarded it, with the backend's outcome. */
export interface IngestCallState {
	readonly messageId: string;
	readonly remoteUid: number;
	readonly outcome: 'stored' | 'duplicate' | 'other';
	readonly held: boolean;
}

export interface BackfillState {
	/** Every message row of the imported mailbox. */
	readonly messages: readonly StoredMessageState[];
	readonly ingestCalls: readonly IngestCallState[];
	/** The import (`mailboxMigrations`). */
	readonly migration: {
		readonly status: string;
		readonly messagesTotal: number;
		readonly messagesImported: number;
		readonly messagesFailed?: number;
	} | null;
	/** The INBOX cursor row (`externalMailFolderSync`). */
	readonly inbox: {
		readonly backfillCursor?: number;
		readonly backfillTotal?: number;
		readonly backfillDone?: number;
	} | null;
}

/**
 * `uids` are the fixture's INBOX UIDs; `heldUid` is the message the backend
 * had committed, unanswered, when the worker was killed.
 */
export function checkBackfillRun(
	uids: readonly number[],
	heldUid: number,
	state: BackfillState
): string[] {
	const failures: string[] = [];
	for (const uid of uids) {
		const rows = state.messages.filter((row) => row.subject === backfillSubject(uid));
		if (rows.length !== 1) {
			failures.push(
				`UID ${uid}: stored ${rows.length} times${rows.length > 1 ? ` (${rows.map((r) => r.rfc822MessageId).join(', ')})` : ''}, expected once`
			);
		}
	}
	if (state.messages.length !== uids.length) {
		failures.push(
			`the mailbox holds ${state.messages.length} messages for a ${uids.length}-message fixture`
		);
	}
	const held = state.ingestCalls.filter((call) => call.remoteUid === heldUid);
	if (!held.some((call) => call.held)) {
		failures.push(`UID ${heldUid}: the kill never landed on its ingest`);
	} else if (!held.some((call) => !call.held && call.outcome === 'duplicate')) {
		// The restart must walk the interrupted batch again. A message the server
		// had already stored comes back as a duplicate of the same identity; a
		// worker that skipped the batch, or minted a new identity, does not.
		failures.push(`UID ${heldUid}: not re-ingested as a duplicate after the restart`);
	}
	const { inbox, migration } = state;
	if (inbox?.backfillCursor !== 0) {
		failures.push(`backfill cursor ${inbox?.backfillCursor ?? 'missing'}, expected 0`);
	}
	if (inbox?.backfillTotal !== uids.length || inbox.backfillDone !== uids.length) {
		failures.push(
			`INBOX walked ${inbox?.backfillDone ?? 'none'} of ${inbox?.backfillTotal ?? 'none'}, expected ${uids.length} of ${uids.length}`
		);
	}
	if (migration?.status !== 'completed') {
		failures.push(`import ${migration?.status ?? 'missing'}, expected completed`);
	}
	const imported = migration?.messagesImported;
	const failed = migration?.messagesFailed ?? 0;
	if (imported !== uids.length || failed !== 0 || migration?.messagesTotal !== uids.length) {
		failures.push(
			`import counted ${imported ?? 'none'} imported and ${failed} failed of ${migration?.messagesTotal ?? 'none'}, expected ${uids.length} and 0 of ${uids.length}`
		);
	}
	return failures;
}
