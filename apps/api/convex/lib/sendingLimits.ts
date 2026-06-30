import type { Doc } from '../_generated/dataModel';

/**
 * Compute the next `dailySendCount` + reset timestamp for an instanceSettings
 * row, applying the UTC day reset. Pure: the caller folds the returned fields
 * into a SINGLE instanceSettings patch. The transactional dispatch path already
 * holds the settings row, so the old `incrementDailySendCount(ctx, ...)` — which
 * re-fetched the singleton and patched it a second time — just doubled the OCC
 * pressure on the one config row on a latency-sensitive path.
 */
export function nextDailySendCount(
	settings: Pick<Doc<'instanceSettings'>, 'dailySendCount' | 'dailySendCountResetAt'>,
	count: number,
	now: number,
): { dailySendCount: number; dailySendCountResetAt: number } {
	const startOfDay = new Date(now).setUTCHours(0, 0, 0, 0);
	let currentCount = settings.dailySendCount || 0;
	if (!settings.dailySendCountResetAt || settings.dailySendCountResetAt < startOfDay) {
		currentCount = 0;
	}
	return { dailySendCount: currentCount + count, dailySendCountResetAt: startOfDay };
}

/**
 * Get daily send volume for display purposes.
 * No longer enforces tier-based limits — IP warming is handled by the MTA.
 */
export function getDailySendVolume(
	dailySendCount: number,
	dailySendCountResetAt: number | null | undefined,
): { dailySendCount: number } {
	const now = Date.now();
	const startOfDay = new Date(now).setUTCHours(0, 0, 0, 0);

	let currentCount = dailySendCount || 0;
	if (!dailySendCountResetAt || dailySendCountResetAt < startOfDay) {
		currentCount = 0;
	}

	return { dailySendCount: currentCount };
}
