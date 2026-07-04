/**
 * Pure smart-snooze preset inference (packages/shared/snoozePresets).
 *
 * Deterministic: fixed `now` + UTC offset so every wake timestamp is exact.
 *   - detectSnoozeHint maps thread wording to a preset key
 *   - computeSnoozePresets resolves the standard presets to absolute times,
 *     omits "later today" once the workday has ended, badges the suggestion,
 *     and derives "until I'm back" from the working-hours window.
 */

import { describe, it, expect } from 'vitest';
import {
	detectSnoozeHint,
	computeSnoozePresets,
	DEFAULT_WORKING_HOURS,
	type SnoozePreset,
	type SnoozePresetKey,
} from '@owlat/shared/snoozePresets';

// Wed 2026-01-07 10:00 UTC (Jan 1 2026 is a Thursday → the 7th is a Wednesday).
const WED_10_UTC = Date.UTC(2026, 0, 7, 10, 0, 0);

function byKey(presets: SnoozePreset[], key: SnoozePresetKey): SnoozePreset | undefined {
	return presets.find((p) => p.key === key);
}

describe('detectSnoozeHint', () => {
	it('maps thread wording to a preset key', () => {
		expect(detectSnoozeHint('Can you get back to me next week?')).toBe('next_week');
		expect(detectSnoozeHint('Let us talk this weekend')).toBe('this_weekend');
		expect(detectSnoozeHint('Reply tomorrow morning please')).toBe('tomorrow_am');
		expect(detectSnoozeHint('I will send it this evening')).toBe('this_evening');
		expect(detectSnoozeHint('Handle this afternoon')).toBe('later_today');
		expect(detectSnoozeHint('Bare tomorrow works')).toBe('tomorrow_am');
	});

	it('returns null when nothing matches or the text is empty', () => {
		expect(detectSnoozeHint('no temporal wording here')).toBeNull();
		expect(detectSnoozeHint('')).toBeNull();
		expect(detectSnoozeHint(undefined)).toBeNull();
	});
});

describe('computeSnoozePresets', () => {
	it('resolves each preset to the expected absolute wake time (UTC)', () => {
		const presets = computeSnoozePresets({ now: WED_10_UTC, tzOffsetMinutes: 0 });
		expect(byKey(presets, 'later_today')?.at).toBe(Date.UTC(2026, 0, 7, 18));
		expect(byKey(presets, 'this_evening')?.at).toBe(Date.UTC(2026, 0, 7, 20));
		expect(byKey(presets, 'tomorrow_am')?.at).toBe(Date.UTC(2026, 0, 8, 9));
		// Wed → upcoming Saturday is the 10th; Monday is the 12th.
		expect(byKey(presets, 'this_weekend')?.at).toBe(Date.UTC(2026, 0, 10, 9));
		expect(byKey(presets, 'next_week')?.at).toBe(Date.UTC(2026, 0, 12, 9));
	});

	it('omits "later today" once the workday has ended and rolls the evening forward', () => {
		const evening = Date.UTC(2026, 0, 7, 21); // 21:00, past both work-end and 20:00
		const presets = computeSnoozePresets({ now: evening, tzOffsetMinutes: 0 });
		expect(byKey(presets, 'later_today')).toBeUndefined();
		// Evening already passed today → rolls to tomorrow 20:00.
		expect(byKey(presets, 'this_evening')?.at).toBe(Date.UTC(2026, 0, 8, 20));
	});

	it('badges only the suggested preset', () => {
		const presets = computeSnoozePresets({
			now: WED_10_UTC,
			tzOffsetMinutes: 0,
			suggested: 'next_week',
		});
		expect(byKey(presets, 'next_week')?.suggested).toBe(true);
		expect(byKey(presets, 'tomorrow_am')?.suggested).toBeUndefined();
	});

	it('"until I\'m back" is today when the workday has not yet started', () => {
		const earlyWed = Date.UTC(2026, 0, 7, 6); // 06:00 Wed, before the 9:00 start
		const presets = computeSnoozePresets({ now: earlyWed, tzOffsetMinutes: 0 });
		expect(byKey(presets, 'until_im_back')?.at).toBe(Date.UTC(2026, 0, 7, 9));
	});

	it('"until I\'m back" skips the weekend to the next working morning', () => {
		const sat = Date.UTC(2026, 0, 10, 10); // Saturday 10:00
		const presets = computeSnoozePresets({
			now: sat,
			tzOffsetMinutes: 0,
			workingHours: DEFAULT_WORKING_HOURS,
		});
		// Sat/Sun are off → next workday morning is Monday the 12th at 09:00.
		expect(byKey(presets, 'until_im_back')?.at).toBe(Date.UTC(2026, 0, 12, 9));
	});
});
