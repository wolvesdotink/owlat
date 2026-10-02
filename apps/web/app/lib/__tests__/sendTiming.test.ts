import { describe, expect, it } from 'vitest';
import {
	defaultSendTiming,
	sendTimingFromCampaign,
	sendTimingScheduleArgs,
} from '~/lib/sendTiming';

const START = new Date('2026-03-11T09:30:00');

describe('send timing', () => {
	it('reads a stored campaign back into the panel', () => {
		expect(sendTimingFromCampaign({})).toEqual(defaultSendTiming('fixed'));
		expect(sendTimingFromCampaign({ useRecipientTimezone: true }).mode).toBe('local');
		expect(
			sendTimingFromCampaign({
				useRecipientTimezone: false,
				sendTimeOptimization: { windowHours: 12, holdoutPercent: 5 },
			})
		).toEqual({ mode: 'optimized', windowHours: 12, holdoutPercent: 5 });
	});

	it('defaults the optimizer to a 24-hour window with a 10% comparison group', () => {
		expect(defaultSendTiming('optimized')).toEqual({
			mode: 'optimized',
			windowHours: 24,
			holdoutPercent: 10,
		});
	});

	it('maps each mode to the schedule arguments, switching the others off', () => {
		expect(sendTimingScheduleArgs(defaultSendTiming('fixed'), START)).toEqual({
			useRecipientTimezone: false,
			sendTimeOptimization: null,
		});
		expect(sendTimingScheduleArgs(defaultSendTiming('local'), START)).toEqual({
			useRecipientTimezone: true,
			scheduledHour: 9,
			scheduledMinute: 30,
			sendTimeOptimization: null,
		});
		expect(
			sendTimingScheduleArgs({ mode: 'optimized', windowHours: 48, holdoutPercent: 0 }, START)
		).toEqual({
			useRecipientTimezone: false,
			scheduledHour: 9,
			scheduledMinute: 30,
			sendTimeOptimization: { windowHours: 48, holdoutPercent: 0 },
		});
	});
});
