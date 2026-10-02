/**
 * The response-targets settings form: conversions between the stored policy
 * (`inbox/sla/policy.ts`, minutes everywhere) and what a person edits (an
 * amount and a unit, `HH:MM` clock times), plus the form-side checks that
 * mirror the backend's (`inbox/sla/policyRules.ts`). Pure; problems come back
 * as catalog keys.
 */

export type SlaTargetUnit = 'minutes' | 'hours' | 'days';

export const SLA_TARGET_UNITS: readonly SlaTargetUnit[] = ['minutes', 'hours', 'days'];

const UNIT_MINUTES: Record<SlaTargetUnit, number> = { minutes: 1, hours: 60, days: 24 * 60 };

/** Thirty days, the backend's ceiling for a target. */
export const SLA_MAX_TARGET_MINUTES = 30 * 24 * 60;

export interface SlaPolicyShape {
	isEnabled: boolean;
	firstResponseMinutes: number;
	nextResponseMinutes: number;
	hoursMode: 'business' | 'calendar';
	timeZone: string;
	businessHours: { day: number; start: number; end: number }[];
	holidays: string[];
}

/** One weekday row of the form: open or closed, and its `HH:MM` window. */
export interface SlaDayRow {
	day: number;
	isOpen: boolean;
	start: string;
	end: string;
}

export interface SlaPolicyFormState {
	isEnabled: boolean;
	first: { amount: number; unit: SlaTargetUnit };
	next: { amount: number; unit: SlaTargetUnit };
	hoursMode: 'business' | 'calendar';
	timeZone: string;
	days: SlaDayRow[];
	holidays: string[];
}

/**
 * What the form starts from before anything is saved: off, 4 h / 8 h, Mon–Fri
 * 9–17. The page fills in the browser's time zone. (The backend has no
 * default: an absent policy is simply off.)
 */
export const DEFAULT_SLA_FORM_POLICY: SlaPolicyShape = {
	isEnabled: false,
	firstResponseMinutes: 4 * 60,
	nextResponseMinutes: 8 * 60,
	hoursMode: 'business',
	timeZone: 'UTC',
	businessHours: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9 * 60, end: 17 * 60 })),
	holidays: [],
};

/** Monday first, the order the form lists weekdays in. */
export const SLA_WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** The largest unit that states `minutes` exactly ("4 hours", not "240 minutes"). */
export function targetToParts(minutes: number): { amount: number; unit: SlaTargetUnit } {
	if (minutes % UNIT_MINUTES.days === 0)
		return { amount: minutes / UNIT_MINUTES.days, unit: 'days' };
	if (minutes % UNIT_MINUTES.hours === 0) {
		return { amount: minutes / UNIT_MINUTES.hours, unit: 'hours' };
	}
	return { amount: minutes, unit: 'minutes' };
}

export function partsToMinutes(parts: { amount: number; unit: SlaTargetUnit }): number {
	return Math.round(parts.amount * UNIT_MINUTES[parts.unit]);
}

/** Minutes from midnight as `HH:MM`; the end of the day (1440) reads `00:00`. */
export function minutesToClock(minutes: number): string {
	const m = minutes % (24 * 60);
	return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * `HH:MM` as minutes from midnight. An END of `00:00` means midnight at the
 * close of the day (1440), so "09:00 – 00:00" is open until midnight.
 */
export function clockToMinutes(clock: string, isEnd = false): number {
	const [h, m] = clock.split(':').map((part) => Number.parseInt(part, 10));
	const minutes = (Number.isFinite(h) ? h! : 0) * 60 + (Number.isFinite(m) ? m! : 0);
	return isEnd && minutes === 0 ? 24 * 60 : minutes;
}

/** The form state for a stored (or default) policy. */
export function policyToForm(policy: SlaPolicyShape): SlaPolicyFormState {
	return {
		isEnabled: policy.isEnabled,
		first: targetToParts(policy.firstResponseMinutes),
		next: targetToParts(policy.nextResponseMinutes),
		hoursMode: policy.hoursMode,
		timeZone: policy.timeZone,
		days: SLA_WEEKDAY_ORDER.map((day) => {
			const hours = policy.businessHours.find((h) => h.day === day);
			return {
				day,
				isOpen: hours !== undefined,
				start: minutesToClock(hours?.start ?? 9 * 60),
				end: minutesToClock(hours?.end ?? 17 * 60),
			};
		}),
		holidays: [...policy.holidays],
	};
}

/** The policy the form saves. Closed days are left out. */
export function formToPolicy(form: SlaPolicyFormState): SlaPolicyShape {
	return {
		isEnabled: form.isEnabled,
		firstResponseMinutes: partsToMinutes(form.first),
		nextResponseMinutes: partsToMinutes(form.next),
		hoursMode: form.hoursMode,
		timeZone: form.timeZone.trim(),
		businessHours: form.days
			.filter((row) => row.isOpen)
			.map((row) => ({
				day: row.day,
				start: clockToMinutes(row.start),
				end: clockToMinutes(row.end, true),
			})),
		holidays: [...new Set(form.holidays)].sort(),
	};
}

function isValidTimeZone(timeZone: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone });
		return timeZone.length > 0;
	} catch {
		return false;
	}
}

/** Why the form cannot be saved, as a catalog key, or `null`. */
export function policyFormProblem(policy: SlaPolicyShape): string | null {
	const base = 'components.inbox.inboxSlaPolicyForm.problems';
	for (const minutes of [policy.firstResponseMinutes, policy.nextResponseMinutes]) {
		if (!Number.isInteger(minutes) || minutes < 1 || minutes > SLA_MAX_TARGET_MINUTES) {
			return `${base}.target`;
		}
	}
	if (!isValidTimeZone(policy.timeZone)) return `${base}.timeZone`;
	if (policy.businessHours.some((h) => h.start >= h.end)) return `${base}.hours`;
	if (policy.hoursMode === 'business' && policy.businessHours.length === 0) {
		return `${base}.noOpenDay`;
	}
	return null;
}
