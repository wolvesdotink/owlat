/**
 * How long a cached MTA health snapshot stays current, and when a new poll may
 * skip writing it.
 *
 * The snapshot lives on the `instanceSettings` singleton, which every feature
 * flag gate reads, so each write re-runs every flag-gated query on the
 * deployment. The sync cron polls every two minutes, and almost every poll
 * repeats the last one: the MTA stamps `checkedAt` on its TLS and SMTP probe
 * results each time it answers, so only the timestamps differ. `record` skips
 * such a poll until the stored snapshot is `MTA_HEALTH_RESTAMP_MS` old, then
 * writes it once to re-stamp it. Any change in status or in a signal is written
 * straight away.
 *
 * Readers therefore judge a snapshot by `MTA_HEALTH_MAX_AGE_MS`. The re-stamp
 * lands on the first poll at or after the interval, so a stored snapshot can be
 * one poll older than the interval; on top of that come two missed polls and a
 * minute of slack. A snapshot older than that means the sync itself stopped.
 *
 * Leaf module: types and constants only, so checklist validators and queries
 * can import it without loading the cron action.
 */

import type { Infer } from 'convex/values';
import type { mtaHealthSnapshotValidator } from '../schema/instance';

type MtaHealthSnapshot = Infer<typeof mtaHealthSnapshotValidator>;

/** The `sync MTA health` cron's cadence (delivery/cronRegistration.ts). */
export const MTA_HEALTH_SYNC_INTERVAL_MS = 2 * 60_000;

/** An unchanged snapshot is rewritten once the stored one is this old. */
export const MTA_HEALTH_RESTAMP_MS = 10 * 60_000;

/** Readers treat a snapshot (and the probe results inside it) older than this as stale. */
export const MTA_HEALTH_MAX_AGE_MS =
	MTA_HEALTH_RESTAMP_MS + 3 * MTA_HEALTH_SYNC_INTERVAL_MS + 60_000;

/** The snapshot without the timestamps every poll refreshes. */
function signals(snapshot: MtaHealthSnapshot): unknown {
	const { observedAt: _observedAt, smtpOutbound, smtpTls, ...rest } = snapshot;
	return {
		...rest,
		...(smtpOutbound ? { smtpOutbound: { ...smtpOutbound, checkedAt: undefined } } : {}),
		...(smtpTls ? { smtpTls: { ...smtpTls, checkedAt: undefined } } : {}),
	};
}

/** JSON with sorted object keys and `undefined` members dropped, so field order never counts. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, member]) => member !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonical(member)}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

/**
 * Whether `record` can leave `stored` in place for `next`: nothing but the
 * timestamps differs, and `stored` is still inside the re-stamp interval.
 */
export function canSkipMtaHealthWrite(
	stored: MtaHealthSnapshot | undefined,
	next: MtaHealthSnapshot
): boolean {
	if (!stored) return false;
	// A poll that finished before the stored one (a checklist sweep racing the
	// cron) and says the same thing has nothing to add either.
	if (next.observedAt - stored.observedAt >= MTA_HEALTH_RESTAMP_MS) return false;
	return canonical(signals(stored)) === canonical(signals(next));
}
