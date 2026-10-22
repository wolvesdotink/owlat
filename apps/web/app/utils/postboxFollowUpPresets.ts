/**
 * The "remind me if no reply by…" presets, as catalog keys and the moments they
 * stand for. Shared by the follow-up dialog and the palette's "Remind me if no
 * reply ›" submenu, so both offer the same times under the same words.
 */

/** One follow-up preset: catalog keys for its two lines, and when it fires. */
interface FollowUpPreset {
	id: 'tomorrow' | 'inThreeDays' | 'nextWeek';
	labelKey: string;
	subKey: string;
	at: number;
}

const K = 'components.postbox.postboxFollowUpDialog.presets';

/** `hour`:00 local time, `dayOffset` days after `now`. Pure. */
function nextOccurrence(now: Date, hour: number, dayOffset: number): number {
	const d = new Date(now.getTime());
	d.setDate(d.getDate() + dayOffset);
	d.setHours(hour, 0, 0, 0);
	return d.getTime();
}

/** Tomorrow morning, in three days, next Monday morning — from `now`. Pure. */
export function followUpPresets(now: Date): FollowUpPreset[] {
	const dow = now.getDay();
	return [
		{
			id: 'tomorrow',
			labelKey: `${K}.tomorrow`,
			subKey: `${K}.morning`,
			at: nextOccurrence(now, 9, 1),
		},
		{
			id: 'inThreeDays',
			labelKey: `${K}.inThreeDays`,
			subKey: `${K}.morning`,
			at: nextOccurrence(now, 9, 3),
		},
		{
			id: 'nextWeek',
			labelKey: `${K}.nextWeek`,
			subKey: `${K}.mondayMorning`,
			at: nextOccurrence(now, 9, (8 - dow) % 7 || 7),
		},
	];
}
