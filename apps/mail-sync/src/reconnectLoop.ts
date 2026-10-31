/**
 * The connect-with-backoff loop of one account connection (connection.ts).
 *
 * Reconnect uses exponential backoff with jitter. A login the provider keeps
 * rejecting for AUTH_REJECTION_GRACE_MS is terminal: the account is marked
 * `auth_error` and the connection stops until the user re-enters credentials
 * (the reconcile loop then restarts it). A single rejection is not, and neither
 * is the backend refusing to mint credentials — see connectUntilConnected.
 */

import { sleep } from '@owlat/shared';
import { nextDelay, type RetryPolicy } from '@owlat/shared/retryPolicy';
import { CredentialsUnavailableError } from './convex.js';
import { AUTH_REJECTION_GRACE_MS, describeConnectError, isAuthError } from './loginFailure.js';
import { logger } from './logger.js';

/** 5 s, doubling to 5 min, plus up to a second of jitter. */
const RECONNECT_BACKOFF: RetryPolicy = {
	baseMs: 5000,
	capMs: 5 * 60 * 1000,
	jitter: { kind: 'fixed', maxMs: 1000 },
};

/** What the loop needs from the connection it reconnects. */
export interface ReconnectHost {
	readonly accountId: string;
	isStopped(): boolean;
	/** Stop for good; only a restart from the reconcile loop brings the account back. */
	halt(): void;
	/** One attempt: fetch credentials, log in and open the session, or throw. */
	connectOnce(): Promise<void>;
	setStatus(status: 'auth_error' | 'error', lastError: string): Promise<void>;
}

export class ReconnectLoop {
	// Connect attempts that failed since the last session opened.
	private failures = 0;
	// One reconnect loop per account, ever (see run).
	private isRunning = false;
	// When the current run of back-to-back login rejections began. Reset by a
	// login the provider accepts and by any failure that is not a rejection.
	private authRejectedSince: number | null = null;

	constructor(private readonly host: ReconnectHost) {}

	/**
	 * Connect, backing off between failures, until connected or stopped. Never
	 * runs twice at once: a second loop would double every connect attempt and
	 * status write, and each of its failures could start yet another — the
	 * reconnect storm that once took Convex down with thousands of attempts a
	 * minute.
	 */
	async run(): Promise<void> {
		if (this.isRunning) return;
		this.isRunning = true;
		try {
			await this.connectUntilConnected();
		} finally {
			this.isRunning = false;
		}
	}

	/** The provider accepted a login: the backoff and the rejection streak start over. */
	markConnected(): void {
		this.authRejectedSince = null;
		this.failures = 0;
	}

	private async connectUntilConnected(): Promise<void> {
		const { accountId } = this.host;
		while (!this.host.isStopped()) {
			try {
				await this.host.connectOnce();
				return; // connected; event-driven + timer from here
			} catch (err) {
				const message = describeConnectError(err);
				// The backend refused to hand over credentials and only the user can
				// change that: the Google grant behind them was revoked, or the member
				// disconnected the account and the password was dropped with it. Either
				// way the backend has already written the status that is true, so stop
				// WITHOUT a status write — ours would overwrite the only actionable
				// message with a generic one, and on a disconnected account it would
				// put the row back into a connectable state with no credential in it.
				// Retrying would spend a token request per pass forever.
				if (err instanceof CredentialsUnavailableError && err.isTerminal) {
					logger.warn(
						{ accountId, reason: err.reason },
						'account can no longer be connected — pausing until the user reconnects it'
					);
					this.host.halt();
					return;
				}
				if (isAuthError(err)) {
					const now = Date.now();
					this.authRejectedSince ??= now;
					if (now - this.authRejectedSince >= AUTH_REJECTION_GRACE_MS) {
						logger.warn(
							{ accountId, err },
							'login still rejected — pausing until credentials are updated'
						);
						await this.host.setStatus('auth_error', message);
						this.host.halt();
						return;
					}
					// Retried on the ordinary backoff below. The status is `error`,
					// which keeps the account connectable and already shows the
					// member the reconnect form should the rejection persist.
					logger.warn(
						{ accountId, err },
						'login rejected; retrying before treating the credentials as wrong'
					);
				} else {
					// Anything else breaks the streak: the grace period measures logins
					// refused back to back, and a temporary refusal or a dropped socket
					// in between says nothing about the credentials.
					this.authRejectedSince = null;
					logger.warn({ accountId, err }, 'connect failed; backing off');
				}
				await this.host.setStatus('error', message);
				await sleep(nextDelay(RECONNECT_BACKOFF, this.failures++));
			}
		}
	}
}
