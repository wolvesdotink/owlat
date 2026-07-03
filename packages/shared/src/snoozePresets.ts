/**
 * Smart-snooze preset inference — pure, deterministic, no I/O.
 *
 * Shared by the Postbox snooze dialog (apps/web) and the Convex backend
 * (apps/api mail/snooze.ts) so the label/time math and the content-hint
 * inference live in exactly one place and can never drift.
 *
 * Given `now`, the user's timezone offset, and their working-hours window, it
 * resolves the standard snooze presets to absolute wake timestamps. Given the
 * thread's text it deterministically infers which preset the message hints at
 * ("get back to me tomorrow morning" -> `tomorrow_am`) — this is the
 * "AI-suggested wake time" floor.
 *
 * An optional cheap-tier LLM classifier can override {@link detectSnoozeHint}
 * by passing its own key to {@link computeSnoozePresets} via `suggested`; when
 * that call is unavailable or errors, the caller falls back to the deterministic
 * hint (or none), so the picker degrades to plain static presets — it never
 * blocks and never invents a wake time the user did not choose.
 */

export type SnoozePresetKey =
	| 'later_today'
	| 'this_evening'
	| 'tomorrow_am'
	| 'this_weekend'
	| 'next_week'
	| 'until_im_back';

export interface WorkingHours {
	/** Local hour (0–23) the workday starts — the "back at work" wake hour. */
	startHour: number;
	/** Local hour (0–23) the workday ends — the "later today" wake hour. */
	endHour: number;
	/** `Date.getDay()` indices (0=Sun … 6=Sat) that count as workdays. */
	workdays: number[];
}

/** Fallback window when no per-user working hours are configured (9–6, Mon–Fri). */
export const DEFAULT_WORKING_HOURS: WorkingHours = {
	startHour: 9,
	endHour: 18,
	workdays: [1, 2, 3, 4, 5],
};

/** Evening wake hour for the "this evening" preset. */
const EVENING_HOUR = 20;

export interface SnoozePreset {
	key: SnoozePresetKey;
	label: string;
	/** Short human sublabel, e.g. "6:00 PM" or "Mon 9:00 AM". */
	sub: string;
	/** Absolute wake time, epoch-ms. */
	at: number;
	/** True when the thread content (or the optional LLM) points at this preset. */
	suggested?: boolean;
}

// ── Timezone-aware wall-clock math ───────────────────────────────────────────
// `tzOffsetMinutes` is minutes EAST of UTC (UTC+2 -> +120), i.e.
// `-new Date().getTimezoneOffset()`. We shift the epoch into a Date whose UTC
// getters read as the user's local wall clock, then shift the constructed
// target back. DST transitions between `now` and the target are ignored — an
// acceptable ~1h drift for a snooze, never a correctness bug.

function localParts(now: number, tzOffsetMinutes: number): Date {
	return new Date(now + tzOffsetMinutes * 60_000);
}

/** Epoch-ms for `hour:00` local, `dayOffset` days from today's local date. */
function atLocalHour(
	now: number,
	tzOffsetMinutes: number,
	hour: number,
	dayOffset: number,
): number {
	const local = localParts(now, tzOffsetMinutes);
	const target = Date.UTC(
		local.getUTCFullYear(),
		local.getUTCMonth(),
		local.getUTCDate() + dayOffset,
		hour,
		0,
		0,
		0,
	);
	return target - tzOffsetMinutes * 60_000;
}

/** Local day-of-week (0=Sun … 6=Sat) at `now`. */
function localDow(now: number, tzOffsetMinutes: number): number {
	return localParts(now, tzOffsetMinutes).getUTCDay();
}

/** Local hour (0–23) at `now`. */
function localHour(now: number, tzOffsetMinutes: number): number {
	return localParts(now, tzOffsetMinutes).getUTCHours();
}

const WEEKDAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "6:00 PM" style label from a local hour. */
function clockLabel(hour: number): string {
	const period = hour < 12 ? 'AM' : 'PM';
	const h12 = hour % 12 === 0 ? 12 : hour % 12;
	return `${h12}:00 ${period}`;
}

/**
 * Days from today's local date to the next occurrence of `targetDow` that is
 * strictly in the future. Same-day requests roll a full week forward.
 */
function daysUntilDow(now: number, tzOffsetMinutes: number, targetDow: number): number {
	const today = localDow(now, tzOffsetMinutes);
	const diff = (targetDow - today + 7) % 7;
	return diff === 0 ? 7 : diff;
}

/**
 * Days from today's local date to the next working-day whose start hour is
 * still in the future — the "until I'm back" wake day. If today is a workday
 * and its start hour has not passed, that's today (offset 0).
 */
function daysUntilBackAtWork(now: number, tzOffsetMinutes: number, wh: WorkingHours): number {
	const workdays = wh.workdays.length > 0 ? wh.workdays : DEFAULT_WORKING_HOURS.workdays;
	const today = localDow(now, tzOffsetMinutes);
	const hour = localHour(now, tzOffsetMinutes);
	for (let offset = 0; offset < 8; offset++) {
		const dow = (today + offset) % 7;
		if (!workdays.includes(dow)) continue;
		// Today only counts if the workday start hasn't already passed.
		if (offset === 0 && hour >= wh.startHour) continue;
		return offset;
	}
	// Degenerate config (no workdays matched in a week) — tomorrow morning.
	return 1;
}

// ── Deterministic content-hint inference ─────────────────────────────────────

interface HintRule {
	key: SnoozePresetKey;
	test: RegExp;
}

// Ordered most-specific first; the first match wins. Kept deliberately narrow —
// a false "suggested" badge is worse than none, and the user always sees every
// preset regardless.
const HINT_RULES: HintRule[] = [
	{ key: 'next_week', test: /\bnext week\b|\bafter the weekend\b/ },
	{ key: 'this_weekend', test: /\b(this |the )?weekend\b|\b(on |this )?(saturday|sunday)\b/ },
	{
		key: 'tomorrow_am',
		test: /\btomorrow (morning|am|first thing|a\.m\.)\b|\bfirst thing tomorrow\b|\btomorrow\b/,
	},
	{ key: 'this_evening', test: /\b(this evening|tonight|later tonight|end of day|by eod|by end of day)\b/ },
	{ key: 'later_today', test: /\b(this afternoon|later today|in a (few|couple of) hours)\b/ },
	{ key: 'next_week', test: /\b(monday|next mon)\b/ },
];

/**
 * Infer the snooze preset a thread's text hints at, or `null` when nothing
 * matches. Deterministic keyword match — the cheap-tier LLM (if wired) may
 * override this, and everything degrades to `null` (plain static presets).
 */
export function detectSnoozeHint(text: string | undefined | null): SnoozePresetKey | null {
	if (!text) return null;
	const t = text.toLowerCase();
	for (const rule of HINT_RULES) {
		if (rule.test.test(t)) return rule.key;
	}
	return null;
}

// ── Preset assembly ──────────────────────────────────────────────────────────

export interface ComputeSnoozePresetsOptions {
	now: number;
	/** Minutes EAST of UTC, i.e. `-new Date().getTimezoneOffset()`. */
	tzOffsetMinutes: number;
	workingHours?: WorkingHours;
	/**
	 * Preset to badge as suggested. Pass the cheap-tier LLM's pick, or the
	 * result of {@link detectSnoozeHint}, or `null`/omit for none.
	 */
	suggested?: SnoozePresetKey | null;
}

/**
 * Resolve the standard snooze presets to absolute wake timestamps for `now`,
 * marking `suggested` when its key is present. Presets whose time has already
 * passed today (e.g. "later today" after work end) are omitted, matching the
 * dialog's long-standing behaviour.
 */
export function computeSnoozePresets(opts: ComputeSnoozePresetsOptions): SnoozePreset[] {
	const { now, tzOffsetMinutes } = opts;
	const wh = opts.workingHours ?? DEFAULT_WORKING_HOURS;
	const hour = localHour(now, tzOffsetMinutes);
	const presets: SnoozePreset[] = [];

	// Later today @ work-end — only while it's still ahead of us.
	if (hour < wh.endHour) {
		presets.push({
			key: 'later_today',
			label: 'Later today',
			sub: clockLabel(wh.endHour),
			at: atLocalHour(now, tzOffsetMinutes, wh.endHour, 0),
		});
	}

	// This evening @ 8pm (roll to tomorrow if it's already past).
	presets.push({
		key: 'this_evening',
		label: 'This evening',
		sub: clockLabel(EVENING_HOUR),
		at: atLocalHour(now, tzOffsetMinutes, EVENING_HOUR, hour >= EVENING_HOUR ? 1 : 0),
	});

	// Tomorrow morning @ work-start.
	presets.push({
		key: 'tomorrow_am',
		label: 'Tomorrow',
		sub: clockLabel(wh.startHour),
		at: atLocalHour(now, tzOffsetMinutes, wh.startHour, 1),
	});

	// This weekend — upcoming Saturday @ work-start.
	const daysToSat = daysUntilDow(now, tzOffsetMinutes, 6);
	presets.push({
		key: 'this_weekend',
		label: 'This weekend',
		sub: `${WEEKDAY_LABEL[6]} ${clockLabel(wh.startHour)}`,
		at: atLocalHour(now, tzOffsetMinutes, wh.startHour, daysToSat),
	});

	// Next week — upcoming Monday @ work-start.
	const daysToMon = daysUntilDow(now, tzOffsetMinutes, 1);
	presets.push({
		key: 'next_week',
		label: 'Next week',
		sub: `${WEEKDAY_LABEL[1]} ${clockLabel(wh.startHour)}`,
		at: atLocalHour(now, tzOffsetMinutes, wh.startHour, daysToMon),
	});

	// Until I'm back — the next time my working-hours window opens.
	const backOffset = daysUntilBackAtWork(now, tzOffsetMinutes, wh);
	const backDow = localDow(now + backOffset * 86_400_000, tzOffsetMinutes);
	presets.push({
		key: 'until_im_back',
		label: "Until I'm back",
		sub:
			backOffset === 0
				? `Today ${clockLabel(wh.startHour)}`
				: `${WEEKDAY_LABEL[backDow]} ${clockLabel(wh.startHour)}`,
		at: atLocalHour(now, tzOffsetMinutes, wh.startHour, backOffset),
	});

	if (opts.suggested) {
		for (const p of presets) {
			if (p.key === opts.suggested) p.suggested = true;
		}
	}
	return presets;
}
