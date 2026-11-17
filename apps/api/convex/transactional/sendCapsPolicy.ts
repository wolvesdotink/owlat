/**
 * The volume caps of the transactional send API, without the database: their
 * defaults, the range an admin may set them to, and whether one more send fits.
 * `sendCaps.ts` charges them inside the intake; `sendCapSettings.ts` stores
 * what an admin chose.
 *
 * PURE: nothing here reads a clock, a database or the environment
 * (scripts/purity-roots.txt).
 */

import type { Infer } from 'convex/values';
import type { transactionalSendCapsValidator } from '../lib/validators/transactionalSendCaps';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export type StoredTransactionalSendCaps = Infer<typeof transactionalSendCapsValidator>;

export interface TransactionalSendCaps {
	readonly perRecipient: {
		readonly isEnabled: boolean;
		readonly count: number;
		readonly windowMs: number;
	};
	readonly perApiKeyDaily: { readonly isEnabled: boolean; readonly count: number };
}

/**
 * The caps an instance runs with until an admin changes them.
 *
 * Per template and recipient: a person needs a handful of password resets or
 * sign-in links an hour, not more; a loop against one address, or a stranger's
 * address typed into a public form, stops here instead of reaching the mailbox
 * provider as a flood from our domain.
 *
 * Per API key and UTC day: the request-rate limit bounds the rate, not the
 * volume. At that rate one key could send several hundred thousand mails a
 * day, which is what a leaked key does and how a sender ends up on a
 * blocklist. Generous for a real integration.
 */
export const DEFAULT_TRANSACTIONAL_SEND_CAPS: TransactionalSendCaps = {
	perRecipient: { isEnabled: true, count: 5, windowMs: HOUR_MS },
	perApiKeyDaily: { isEnabled: true, count: 50_000 },
};

/**
 * What an admin may set. The upper bounds keep a typo from reading as "no
 * limit": switching a cap off is its own explicit choice.
 */
export const TRANSACTIONAL_SEND_CAP_BOUNDS = {
	perRecipientCount: { min: 1, max: 1_000 },
	perRecipientWindowMs: { min: MINUTE_MS, max: 7 * DAY_MS },
	perApiKeyDailyCount: { min: 1, max: 10_000_000 },
} as const;

/**
 * The caps in force: the stored choice, or the defaults when none was saved.
 */
export function effectiveSendCaps(
	stored: StoredTransactionalSendCaps | undefined
): TransactionalSendCaps {
	if (!stored) return DEFAULT_TRANSACTIONAL_SEND_CAPS;
	return { perRecipient: stored.perRecipient, perApiKeyDaily: stored.perApiKeyDaily };
}

function isWholeInRange(value: number, bounds: { min: number; max: number }): boolean {
	return Number.isInteger(value) && value >= bounds.min && value <= bounds.max;
}

/**
 * Why an admin's caps cannot be saved, or `null` when they can. A count is
 * checked even for a cap that is off, since switching it back on uses it.
 */
export function sendCapsInputError(caps: TransactionalSendCaps): string | null {
	const bounds = TRANSACTIONAL_SEND_CAP_BOUNDS;
	if (!isWholeInRange(caps.perRecipient.count, bounds.perRecipientCount)) {
		return `The per-recipient cap must be a whole number from ${bounds.perRecipientCount.min} to ${bounds.perRecipientCount.max}.`;
	}
	const window = caps.perRecipient.windowMs;
	if (!isWholeInRange(window, bounds.perRecipientWindowMs) || window % MINUTE_MS !== 0) {
		return 'The per-recipient window must be whole minutes, from one minute to seven days.';
	}
	if (!isWholeInRange(caps.perApiKeyDaily.count, bounds.perApiKeyDailyCount)) {
		return `The daily cap per API key must be a whole number from ${bounds.perApiKeyDailyCount.min} to ${bounds.perApiKeyDailyCount.max}.`;
	}
	return null;
}

/** A cap's window in words, for the refusal a caller reads. */
export function describeWindow(windowMs: number): string {
	if (windowMs % DAY_MS === 0) return windowMs === DAY_MS ? 'day' : `${windowMs / DAY_MS} days`;
	if (windowMs % HOUR_MS === 0)
		return windowMs === HOUR_MS ? 'hour' : `${windowMs / HOUR_MS} hours`;
	const minutes = windowMs / MINUTE_MS;
	return minutes === 1 ? 'minute' : `${minutes} minutes`;
}

/**
 * Whether one more send fits under a cap that has `used` sends counted against
 * it, and if not, how long until it does. `drainPerMs` is how fast usage drains
 * (a per-recipient allowance refills continuously); a daily cap passes `null`
 * and its window's end instead.
 */
export function capVerdict(input: {
	readonly used: number;
	readonly cap: number;
	readonly drainPerMs: number | null;
	readonly msUntilWindowEnds: number;
}): { ok: true } | { ok: false; retryAfterMs: number } {
	if (input.used + 1 <= input.cap) return { ok: true };
	const retryAfterMs =
		input.drainPerMs === null
			? input.msUntilWindowEnds
			: (input.used + 1 - input.cap) / input.drainPerMs;
	return { ok: false, retryAfterMs: Math.max(1, Math.ceil(retryAfterMs)) };
}
