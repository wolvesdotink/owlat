/**
 * How a scheduled campaign picks each recipient's delivery time, as the
 * schedule panels (wizard review step, campaign edit page) hold it, and the
 * `schedule` / `reschedule` arguments it maps to. The backend half is
 * `campaigns/sendTimeOptimization.ts`; the bounds here mirror it.
 */

/**
 * - `fixed`: everyone at the chosen instant.
 * - `local`: the chosen wall-clock time in each recipient's time zone.
 * - `optimized`: each contact at the hour they usually read, inside a window.
 */
export type SendTimingMode = 'fixed' | 'local' | 'optimized';

export interface SendTiming {
	mode: SendTimingMode;
	/** Hours after the start in which an optimized send may be placed. */
	windowHours: number;
	/** Share of the audience sent at the start as a comparison group. */
	holdoutPercent: number;
}

export const SEND_TIME_WINDOW_OPTIONS = [6, 12, 24, 48, 72] as const;
export const SEND_TIME_HOLDOUT_OPTIONS = [0, 5, 10, 20] as const;
export const DEFAULT_SEND_TIME_WINDOW_HOURS = 24;
export const DEFAULT_SEND_TIME_HOLDOUT_PERCENT = 10;

export function defaultSendTiming(mode: SendTimingMode = 'fixed'): SendTiming {
	return {
		mode,
		windowHours: DEFAULT_SEND_TIME_WINDOW_HOURS,
		holdoutPercent: DEFAULT_SEND_TIME_HOLDOUT_PERCENT,
	};
}

/** The timing a stored campaign was scheduled with. */
export function sendTimingFromCampaign(campaign: {
	useRecipientTimezone?: boolean;
	sendTimeOptimization?: { windowHours: number; holdoutPercent: number };
}): SendTiming {
	if (campaign.sendTimeOptimization) {
		return { mode: 'optimized', ...campaign.sendTimeOptimization };
	}
	return defaultSendTiming(campaign.useRecipientTimezone ? 'local' : 'fixed');
}

export interface SendTimingArgs {
	useRecipientTimezone: boolean;
	scheduledHour?: number;
	scheduledMinute?: number;
	/** `null` switches optimization off on reschedule. */
	sendTimeOptimization: { windowHours: number; holdoutPercent: number } | null;
}

/**
 * The scheduling arguments for `timing` with the start `startsAt`. The start's
 * wall-clock time travels for the local-time mode and for the optimizer's
 * last fallback (the start time in each contact's own zone).
 */
export function sendTimingScheduleArgs(timing: SendTiming, startsAt: Date): SendTimingArgs {
	const wallClock = { scheduledHour: startsAt.getHours(), scheduledMinute: startsAt.getMinutes() };
	if (timing.mode === 'optimized') {
		return {
			useRecipientTimezone: false,
			...wallClock,
			sendTimeOptimization: {
				windowHours: timing.windowHours,
				holdoutPercent: timing.holdoutPercent,
			},
		};
	}
	if (timing.mode === 'local') {
		return { useRecipientTimezone: true, ...wallClock, sendTimeOptimization: null };
	}
	return { useRecipientTimezone: false, sendTimeOptimization: null };
}
