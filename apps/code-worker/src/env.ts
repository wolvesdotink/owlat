/**
 * Numeric environment settings for the worker.
 *
 * This mirrors `readIntEnv` from `@owlat/shared/nodeEnv` (same parsing rules)
 * because the worker's image compiles a filtered workspace install that does not
 * include `@owlat/shared`. A bare `Number(...)` of the raw value turned `10s` into NaN
 * and accepted `0`; Node runs a timer with either delay after 1 ms, so the poll
 * loop or the plugin-job heartbeat spun against Convex with no error at boot.
 */

/** Node's largest timer delay; anything above it is clamped to 1 ms. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export const POLL_INTERVAL_DEFAULT_MS = 10_000;
export const POLL_INTERVAL_MIN_MS = 1_000;
export const PLUGIN_JOB_HEARTBEAT_DEFAULT_MS = 5_000;
export const PLUGIN_JOB_HEARTBEAT_MIN_MS = 500;

export interface IntEnvOptions {
	readonly default: number;
	readonly min?: number;
	readonly max?: number;
}

/**
 * Read a base-10 integer from `env[key]`.
 *
 * The value is trimmed; an unset, empty or whitespace-only value yields
 * `options.default`. Anything else must be a plain signed decimal integer
 * (`'10s'`, `'10_000'`, `'1e3'` and `'1.5'` are rejected), a safe integer, and
 * inside `[min, max]`, or this throws an error naming the key and the range.
 */
export function readIntEnv(
	env: Readonly<Record<string, string | undefined>>,
	key: string,
	options: IntEnvOptions
): number {
	const raw = env[key]?.trim();
	if (raw === undefined || raw === '') return options.default;
	const { min, max } = options;
	const value = /^[+-]?\d+$/.test(raw) ? Number(raw) : Number.NaN;
	if (
		!Number.isSafeInteger(value) ||
		(min !== undefined && value < min) ||
		(max !== undefined && value > max)
	) {
		throw new Error(
			`${key} must be an integer${describeRange(min, max)}, got ${JSON.stringify(raw)}`
		);
	}
	return value;
}

function describeRange(min: number | undefined, max: number | undefined): string {
	if (min !== undefined && max !== undefined) return ` between ${min} and ${max}`;
	if (min !== undefined) return ` of at least ${min}`;
	if (max !== undefined) return ` of at most ${max}`;
	return '';
}

export interface WorkerTimers {
	/** Idle sleep between queue polls. */
	readonly pollIntervalMs: number;
	/** Heartbeat interval for a running plugin job. */
	readonly pluginJobHeartbeatMs: number;
}

/** Read the worker's timer settings; throws on a value that is not a sane delay. */
export function readWorkerTimers(env: Readonly<Record<string, string | undefined>>): WorkerTimers {
	return {
		pollIntervalMs: readIntEnv(env, 'POLL_INTERVAL_MS', {
			default: POLL_INTERVAL_DEFAULT_MS,
			min: POLL_INTERVAL_MIN_MS,
			max: MAX_TIMER_DELAY_MS,
		}),
		pluginJobHeartbeatMs: readIntEnv(env, 'PLUGIN_JOB_HEARTBEAT_MS', {
			default: PLUGIN_JOB_HEARTBEAT_DEFAULT_MS,
			min: PLUGIN_JOB_HEARTBEAT_MIN_MS,
			max: MAX_TIMER_DELAY_MS,
		}),
	};
}
