/**
 * Observer-mode configuration, read once and in one place (plan §7.4, §12.2).
 *
 * Everything here is V8-safe on purpose: the junk-report mutation has to ask
 * "is observer mode even on?" before it schedules anything, and it cannot
 * import `@owlat/ostr-observer` to find out — that package reaches
 * `@owlat/ostr-core`, which is `node:crypto`. So the cheap half of the gate
 * (the operator's opt-in) lives here, and the half that needs the package
 * (`assertObserverEligible`, and the mailbox count it judges) runs inside the
 * Node action, where it belongs.
 *
 * The two halves are NOT redundant. The flag alone must never be treated as
 * permission to publish: §7.4's floor is what stands between an opted-in
 * one-mailbox instance and a public log entry that names its only user.
 */

import { getBoolean, getOptional } from '../lib/env';

/** How much of the day one observation window covers. Hourly is short enough
 *  that a busy instance publishes promptly and long enough that the k-floor
 *  usually clears in one pass; anything shorter mostly produces held windows
 *  and re-work, since the accumulator widens rather than publishes. */
export const OSTR_WINDOW_MS = 60 * 60 * 1000;

/**
 * Evidence-bundle retention (§7.2). Bundles hold `h=`-signed headers verbatim
 * — Subject and To in practice — so this is a privacy commitment, not a disk
 * budget. The report dedupe memory rides the SAME cutoff: once a bundle is
 * gone its report can no longer be re-admitted, which is exactly when the
 * replay defence would otherwise silently lapse.
 */
export const OSTR_EVIDENCE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Rows one prune pass deletes before rescheduling itself. Matches the other
 *  retention sweeps in `maintenance/retention.ts`. */
export const OSTR_PRUNE_BATCH = 200;

/** Ceiling on the held report queue a single window pass reads. Far above what
 *  a real instance accumulates in 90 days of held windows, and a hard bound on
 *  the work one cron tick can take on. */
export const OSTR_MAX_QUEUED_REPORTS = 2000;

/** Ceiling on the messages one window pass folds into the accumulator, per
 *  mailbox. A window is an hour; a mailbox receiving more than this in an hour
 *  contributes a bounded sample rather than stalling the cron. */
export const OSTR_MAX_WINDOW_MESSAGES_PER_MAILBOX = 1000;

/** Mailboxes one roster page reads. The roster is PAGINATED rather than
 *  truncated: a short denominator is the §7.3 under-attestation pattern
 *  monitors are specified to flag, and an instance with more mailboxes than one
 *  page is exactly the instance whose traffic must be counted whole. */
export const OSTR_MAILBOX_PAGE_SIZE = 500;

/**
 * Pages one roster walk will take before it refuses.
 *
 * A bound has to exist — a cron tick is not unbounded — but exceeding it is a
 * REFUSAL to publish (`roster-too-large`), never a quietly truncated count. The
 * window pass already runs one query per mailbox, so this ceiling is far above
 * what the rest of the pass would tolerate anyway.
 */
export const OSTR_MAX_MAILBOX_PAGES = 20;

/**
 * Retries a submission gets before the ledger gives up on it.
 *
 * Hourly windows, so this is about half a day of a log being unreachable. Past
 * it the row is settled as abandoned rather than retried forever: an unsettled
 * row is never pruned, only the oldest are retried, and a permanently bad log
 * URL would otherwise starve everything behind it while the table grew without
 * limit.
 */
export const OSTR_MAX_SUBMISSION_ATTEMPTS = 12;

/** Ceiling on evidence rows one window pass feeds the key tracker. */
export const OSTR_MAX_WINDOW_EVIDENCE = 2000;

/** Unsettled submissions one window pass retries before publishing new work. */
export const OSTR_MAX_RETRY_SUBMISSIONS = 50;

/** The observer's registry identity plus its submission targets. */
export interface ObserverConfig {
	/** `OSTR_OBSERVER_ENABLED` — the operator opt-in, nothing more. */
	isEnabled: boolean;
	/** `OSTR_OBSERVER_DOMAIN`, untouched. `@owlat/ostr-observer` folds and
	 *  validates it; a second opinion here could only disagree. */
	domain: string | undefined;
	/** `OSTR_OBSERVER_PRIVATE_KEY` — raw base64 ed25519. Never logged. */
	privateKeyBase64: string | undefined;
	/** `OSTR_LOG_URLS`, split and trimmed. `submitAll` collapses duplicates. */
	logUrls: string[];
	/** `OSTR_MIN_MAILBOXES`, when it parses as a non-negative integer.
	 *  `assertObserverEligible` clamps it UP to the packaged floor, so a value
	 *  below the floor is inert rather than dangerous. */
	minMailboxes: number | undefined;
}

/** True when the operator has opted in — the cheap half of the gate. */
export function isObserverModeEnabled(): boolean {
	return getBoolean('OSTR_OBSERVER_ENABLED');
}

function nonEmpty(key: 'OSTR_OBSERVER_DOMAIN' | 'OSTR_OBSERVER_PRIVATE_KEY'): string | undefined {
	const value = getOptional(key)?.trim();
	return value === undefined || value === '' ? undefined : value;
}

function parseMinMailboxes(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const parsed = Number.parseInt(raw.trim(), 10);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function readObserverConfig(): ObserverConfig {
	return {
		isEnabled: isObserverModeEnabled(),
		domain: nonEmpty('OSTR_OBSERVER_DOMAIN'),
		privateKeyBase64: nonEmpty('OSTR_OBSERVER_PRIVATE_KEY'),
		logUrls: (getOptional('OSTR_LOG_URLS') ?? '')
			.split(',')
			.map((url) => url.trim())
			.filter((url) => url !== ''),
		minMailboxes: parseMinMailboxes(getOptional('OSTR_MIN_MAILBOXES')),
	};
}

/**
 * Whether this deployment can actually PUBLISH: it has a name to sign as, a key
 * to sign with, and somewhere to send the result. Missing any of the three, the
 * window cron still aggregates and still holds — losing the traffic would be
 * worse than delaying it — but signs and submits nothing.
 */
export function canPublish(
	config: ObserverConfig
): config is ObserverConfig & { domain: string; privateKeyBase64: string } {
	return (
		config.domain !== undefined &&
		config.privateKeyBase64 !== undefined &&
		config.logUrls.length > 0
	);
}
