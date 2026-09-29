/**
 * Validated integer environment variables for the long-running Node sidecars
 * (mta, imap, mail-sync).
 *
 * Exposed via the `@owlat/shared/nodeEnv` subpath only, next to `nodeShutdown`;
 * it is not re-exported from the `.` barrel. The module itself is pure: callers
 * pass `process.env` (or any string map) in.
 *
 * `parseInt(process.env.X ?? 'default', 10)` fails silently in both directions:
 * `''` is not nullish so it parses to NaN, `'1e3'` parses to 1, and every
 * comparison against NaN is false, which turns a connection cap off or makes an
 * AUTH failure limit refuse everyone. A limit an operator mistyped must stop the
 * boot instead.
 */

/** Allowed range for a TCP listen port. */
export const TCP_PORT_RANGE = { min: 1, max: 65_535 } as const;

/**
 * Allowed range for a delay handed to `setTimeout` / `socket.setTimeout`. Node
 * treats anything above 2^31 - 1 ms as 1 ms, so an oversized idle timeout
 * would fire immediately. Widen `min` to 0 only where 0 already means "no delay".
 */
export const TIMER_DELAY_MS_RANGE = { min: 1, max: 2_147_483_647 } as const;

export interface IntEnvOptions {
	/** Value used when the variable is unset, empty or whitespace-only. */
	default: number;
	/** Smallest accepted value (inclusive). */
	min?: number;
	/** Largest accepted value (inclusive). */
	max?: number;
}

/** A numeric environment variable that is not an integer inside its range. */
class InvalidEnvError extends Error {
	override readonly name = 'InvalidEnvError';

	constructor(
		readonly key: string,
		message: string
	) {
		super(message);
	}
}

function describeRange(min: number | undefined, max: number | undefined): string {
	if (min !== undefined && max !== undefined) return ` between ${min} and ${max}`;
	if (min !== undefined) return ` of at least ${min}`;
	if (max !== undefined) return ` of at most ${max}`;
	return '';
}

/**
 * Read a base-10 integer from `env[key]`.
 *
 * The value is trimmed; an unset, empty or whitespace-only value yields
 * `options.default`. Anything else must be a plain signed decimal integer
 * (`'1e3'`, `'10abc'` and `'1.5'` are rejected), a safe integer, and inside
 * `[min, max]`, or this throws an `InvalidEnvError` naming the key and range.
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
		throw new InvalidEnvError(
			key,
			`${key} must be an integer${describeRange(min, max)}, got ${JSON.stringify(raw)}`
		);
	}
	return value;
}
