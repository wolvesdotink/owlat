/**
 * Whether this browser opted in to the local performance trace
 * (`lib/localPerfTrace.ts`), and with what bound.
 *
 * A leaf of its own because the check runs on every page load, in a plugin
 * that is part of the boot bundle, while the trace itself is loaded only when
 * the answer is yes.
 */
export const LOCAL_PERF_TRACE_KEY = 'owlat:perf-trace';
export const DEFAULT_TRACE_LIMIT = 500;
export const MIN_TRACE_LIMIT = 10;
export const MAX_TRACE_LIMIT = 5000;

/**
 * The bound this browser asked for, or `null` when the trace is off. `on`
 * keeps the default; a number is clamped into the supported range; anything
 * else (including a storage that throws) is off.
 */
export function readLocalPerfTraceLimit(
	storage: Pick<Storage, 'getItem'> | null | undefined
): number | null {
	let raw: string | null;
	try {
		raw = storage?.getItem(LOCAL_PERF_TRACE_KEY) ?? null;
	} catch {
		return null;
	}
	const value = raw?.trim().toLowerCase();
	if (!value) return null;
	if (value === 'on' || value === 'true' || value === '1') return DEFAULT_TRACE_LIMIT;
	if (!/^\d+$/.test(value)) return null;
	return Math.min(MAX_TRACE_LIMIT, Math.max(MIN_TRACE_LIMIT, Number(value)));
}
