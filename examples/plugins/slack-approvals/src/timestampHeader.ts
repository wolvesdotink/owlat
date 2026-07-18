/**
 * Shared parser for the unix-seconds timestamp headers this app authenticates:
 * Slack's `X-Slack-Request-Timestamp` and Owlat's `x-owlat-hook-timestamp`.
 *
 * Both surfaces sign an INTEGER count of seconds since the epoch, so the one
 * accepted grammar is a run of ASCII digits with NO sign — a negative,
 * fractional, or exponential value (`-1`, `1.5`, `1e3`) is not a real timestamp
 * and returns `null`. Keeping the two surfaces on one parser stops them drifting
 * (an earlier copy accepted `^-?\d+$`, letting a negative timestamp through to be
 * caught only later by the freshness window). Surrounding whitespace is
 * tolerated; the value must be a safe integer.
 */
export function parseUnixSecondsHeader(value: string | null | undefined): number | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const parsed = Number(trimmed);
	return Number.isSafeInteger(parsed) ? parsed : null;
}
