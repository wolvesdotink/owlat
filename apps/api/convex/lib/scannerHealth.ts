/**
 * Operator visibility for ClamAV fail-open.
 *
 * Attachment malware scanning is fail-open by design — if ClamAV is configured
 * but unreachable, outbound mail still flows rather than wedging the send path.
 * The hazard is silence: an operator can believe attachments are scanned while
 * they pass through unscanned. The MTA logs the skip, but the convex send path
 * was silent. Surface it here so it shows up in the backend logs the operator
 * actually watches, throttled so a flood of sends doesn't spam.
 */

import { logWarn } from './runtimeLog';

const WARN_THROTTLE_MS = 60_000;
let lastWarnedAt = 0;

/**
 * Best-effort throttled warning that an outbound attachment was sent WITHOUT a
 * malware scan because ClamAV was unavailable (the scan failed open). Throttle
 * state is per-process, so under sustained outage it warns at most once a minute.
 */
export function warnScanSkipped(filename: string, reason?: string): void {
	const now = Date.now();
	if (now - lastWarnedAt < WARN_THROTTLE_MS) return;
	lastWarnedAt = now;
	logWarn('[clamav] attachment sent UNSCANNED — ClamAV unavailable, failing open', { filename, reason });
}

/** Test-only: reset the throttle window. */
export function _resetScannerWarnThrottle(): void {
	lastWarnedAt = 0;
}
