/**
 * Guard for the reader's plain-prose scheduling chip: it renders only for a
 * real scheduling intent, on the trigger message, when the `ai` flag is on,
 * there is NO .ics invite attached, and it has not been dismissed this session.
 */
import { describe, it, expect } from 'vitest';
import {
	shouldShowSchedulingChip,
	isCalendarInviteAttachment,
} from '../postboxSchedulingChip';

const intent = { isScheduling: true, proposedTimes: ['Tuesday afternoon'] };

function base(overrides: Partial<Parameters<typeof shouldShowSchedulingChip>[0]> = {}) {
	return {
		aiEnabled: true,
		meetingIntent: intent,
		triggerMessageId: 'm1',
		message: { _id: 'm1', attachments: [] as { filename: string; contentType: string }[] },
		dismissed: new Set<string>(),
		...overrides,
	};
}

describe('isCalendarInviteAttachment', () => {
	it('detects .ics and text/calendar', () => {
		expect(isCalendarInviteAttachment({ filename: 'x.ics', contentType: 'x' })).toBe(true);
		expect(isCalendarInviteAttachment({ filename: 'x', contentType: 'text/calendar' })).toBe(true);
		expect(isCalendarInviteAttachment({ filename: 'a.pdf', contentType: 'application/pdf' })).toBe(false);
	});
});

describe('shouldShowSchedulingChip', () => {
	it('shows for a scheduling intent on the trigger message with no invite', () => {
		expect(shouldShowSchedulingChip(base())).toBe(true);
	});

	it('hides when the ai flag is off', () => {
		expect(shouldShowSchedulingChip(base({ aiEnabled: false }))).toBe(false);
	});

	it('hides when there is no scheduling intent', () => {
		expect(shouldShowSchedulingChip(base({ meetingIntent: null }))).toBe(false);
		expect(
			shouldShowSchedulingChip(
				base({ meetingIntent: { isScheduling: false, proposedTimes: [] } }),
			),
		).toBe(false);
	});

	it('hides on messages other than the trigger', () => {
		expect(shouldShowSchedulingChip(base({ triggerMessageId: 'other' }))).toBe(false);
	});

	it('hides when the message carries a calendar invite (.ics owns it)', () => {
		expect(
			shouldShowSchedulingChip(
				base({
					message: {
						_id: 'm1',
						attachments: [{ filename: 'invite.ics', contentType: 'text/calendar' }],
					},
				}),
			),
		).toBe(false);
	});

	it('hides once dismissed for the session', () => {
		expect(shouldShowSchedulingChip(base({ dismissed: new Set(['m1']) }))).toBe(false);
	});
});
