// Gentle auto-recheck poller for domain DNS verification.
//
// The Sending Domains settings page verifies DNS on an explicit "Verify" click.
// Once a user has published the records with their DNS provider, propagation can
// take minutes — so instead of making them sit there clicking Verify, we poll the
// existing verify action on a slow interval while the panel is open and stop as
// soon as the domain verifies (or a safety cap is hit).
//
// This module is deliberately framework-agnostic (plain timers, no Vue) so the
// start/stop/cap/in-flight behaviour is unit-testable with fake timers.

export interface AutoRecheckPollerParams {
	// Performs one verification attempt. Resolve `true` to signal "done — stop
	// polling" (i.e. the domain is now verified); resolve `false` to keep going.
	// MUST NOT throw: the poller treats a rejection as fail-soft (see onError) and
	// simply keeps polling until the cap.
	onTick: () => Promise<boolean>;
	// Interval between attempts. Defaults to 30s.
	intervalMs?: number;
	// Maximum number of attempts before giving up (~10 * 30s ≈ 5min). Defaults 10.
	maxAttempts?: number;
	// Fail-soft error sink. Called if onTick rejects; never rethrows.
	onError?: (error: unknown) => void;
}

export interface AutoRecheckPoller {
	start: () => void;
	stop: () => void;
	isRunning: () => boolean;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 10;

export function createAutoRecheckPoller(params: AutoRecheckPollerParams): AutoRecheckPoller {
	const intervalMs = params.intervalMs ?? DEFAULT_INTERVAL_MS;
	const maxAttempts = params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

	let timer: ReturnType<typeof setInterval> | null = null;
	let attempts = 0;
	let inFlight = false;

	const stop = (): void => {
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
		attempts = 0;
		inFlight = false;
	};

	const tick = (): void => {
		// At most one verify in flight at a time — skip this beat if the previous
		// attempt (or a manual verify the caller routed through the same guard)
		// is still running.
		if (inFlight) return;

		attempts += 1;
		inFlight = true;
		void params
			.onTick()
			.then((done) => {
				if (done) {
					stop();
				}
			})
			.catch((error) => {
				// Fail soft: a transient lookup/network error must not tear down the
				// UI or leave an unhandled rejection — just report and keep polling.
				params.onError?.(error);
			})
			.finally(() => {
				inFlight = false;
				// Enforce the safety cap after the attempt settles so we always make
				// exactly `maxAttempts` attempts, no more.
				if (attempts >= maxAttempts) {
					stop();
				}
			});
	};

	const start = (): void => {
		if (timer !== null) return; // already running — don't stack intervals
		attempts = 0;
		inFlight = false;
		timer = setInterval(tick, intervalMs);
	};

	return {
		start,
		stop,
		isRunning: () => timer !== null,
	};
}
