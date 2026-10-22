import { describe, expect, it } from 'vitest';
import { followUpPresets } from '../postboxFollowUpPresets';

describe('followUpPresets', () => {
	// A Wednesday afternoon, local time.
	const now = new Date(2026, 9, 21, 15, 30);

	it('offers tomorrow, in three days and next Monday, each at 9:00', () => {
		const [tomorrow, inThree, nextWeek] = followUpPresets(now).map((preset) => new Date(preset.at));
		expect([tomorrow, inThree, nextWeek].map((d) => [d!.getDate(), d!.getHours()])).toEqual([
			[22, 9],
			[24, 9],
			[26, 9],
		]);
		expect(nextWeek!.getDay()).toBe(1);
	});

	it('names each preset by catalog key', () => {
		expect(followUpPresets(now).map((preset) => preset.labelKey)).toEqual([
			'components.postbox.postboxFollowUpDialog.presets.tomorrow',
			'components.postbox.postboxFollowUpDialog.presets.inThreeDays',
			'components.postbox.postboxFollowUpDialog.presets.nextWeek',
		]);
	});

	it('goes to the Monday after next when it is Monday already', () => {
		const monday = new Date(2026, 9, 19, 10, 0);
		expect(new Date(followUpPresets(monday)[2]!.at).getDate()).toBe(26);
	});
});
