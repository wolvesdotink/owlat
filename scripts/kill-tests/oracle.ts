/**
 * What a kill test must find once the killed process has been restarted and
 * has settled. Pure functions over the world's recorded state (world/main.ts
 * `/control/state`), so the verdicts themselves are unit-tested, negative
 * controls included (scripts/__tests__/kill-tests-oracle.test.ts).
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

export interface WebhookState {
	readonly event: string;
	readonly messageId: string;
	readonly body: Record<string, unknown>;
}

/** Webhook events after which Convex holds the Send in a terminal state. */
export const TERMINAL_EVENTS = ['sent', 'bounced', 'failed'] as const;
/** How the MTA words an ambiguous post-DATA outcome on the `failed` webhook. */
export const AMBIGUOUS_MESSAGE_PREFIX = 'Ambiguous post-DATA drop';

export function checkMtaRun(
	plan: readonly PlannedSend[],
	smtp: readonly SinkTransactionState[],
	webhooks: readonly WebhookState[]
): string[] {
	const failures: string[] = [];
	for (const send of plan) {
		const bodies = smtp.filter((t) => t.bodyReceived && t.rcpts.includes(send.rcpt)).length;
		const terminal = new Set(
			webhooks
				.filter(
					(w) =>
						w.messageId === send.messageId &&
						(TERMINAL_EVENTS as readonly string[]).includes(w.event)
				)
				.map((w) => w.event)
		);
		const label = `${send.messageId}${send.heldAt ? ` (killed at ${send.heldAt})` : ''}`;
		if (bodies !== 1) failures.push(`${label}: the receiver got ${bodies} bodies, expected 1`);
		if (terminal.size !== 1) {
			failures.push(
				`${label}: terminal webhook events [${[...terminal].join(', ')}], expected exactly one kind`
			);
			continue;
		}
		const [event] = [...terminal];
		if (send.heldAt === 'dot') {
			const failed = webhooks.find((w) => w.messageId === send.messageId && w.event === 'failed');
			const message = String(failed?.body['message'] ?? '');
			if (event !== 'failed' || !message.startsWith(AMBIGUOUS_MESSAGE_PREFIX)) {
				failures.push(
					`${label}: expected an ambiguous 'failed' event, got '${event}' (${message || 'no message'})`
				);
			}
		} else if (event !== 'sent') {
			failures.push(`${label}: expected 'sent', got '${event}'`);
		}
	}
	return failures;
}

export interface StoredMessageState {
	readonly messageId: string;
	readonly remoteUid: number;
}

export interface IngestCallState {
	readonly messageId: string;
	readonly remoteUid: number;
	readonly outcome: 'stored' | 'duplicate';
	readonly held: boolean;
}

export interface BackfillState {
	readonly migrationStatus: string;
	readonly inboxCursor: number | null;
	readonly stored: readonly StoredMessageState[];
	readonly ingestCalls: readonly IngestCallState[];
	readonly progress: ReadonlyArray<{ imported: number; failed: number }>;
}

/**
 * `uids` are the fixture's INBOX UIDs; `heldUid` is the message the stub
 * committed and never answered when the worker was killed.
 */
export function checkBackfillRun(
	uids: readonly number[],
	heldUid: number,
	state: BackfillState
): string[] {
	const failures: string[] = [];
	for (const uid of uids) {
		const rows = state.stored.filter((row) => row.remoteUid === uid);
		if (rows.length !== 1) {
			failures.push(
				`UID ${uid}: stored ${rows.length} times${rows.length > 1 ? ` (${rows.map((r) => r.messageId).join(', ')})` : ''}, expected once`
			);
		}
	}
	if (state.stored.length !== uids.length) {
		failures.push(`stored ${state.stored.length} messages for a ${uids.length}-message fixture`);
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
	if (state.inboxCursor !== 0) failures.push(`backfill cursor ${state.inboxCursor}, expected 0`);
	if (state.migrationStatus !== 'finalizing') {
		failures.push(`migration ${state.migrationStatus}, expected the import handed to finalize`);
	}
	const imported = state.progress.reduce((sum, batch) => sum + batch.imported, 0);
	const failed = state.progress.reduce((sum, batch) => sum + batch.failed, 0);
	if (imported !== uids.length || failed !== 0) {
		failures.push(
			`progress counted ${imported} imported and ${failed} failed, expected ${uids.length} and 0`
		);
	}
	return failures;
}
