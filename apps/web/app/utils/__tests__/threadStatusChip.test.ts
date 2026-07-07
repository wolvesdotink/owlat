/**
 * Thread status roll-up (utils/threadStatusChip):
 *   - precedence: resolved (terminal) > snoozed > draft_ready > waiting > open
 *   - `closed` merges to "Resolved"
 *   - a lapsed snooze (snoozedUntil in the past) does not read as Snoozed
 *   - dot-class mapping.
 */
import { describe, it, expect } from 'vitest';
import { threadStatusChip, threadChipDotClass } from '../threadStatusChip';

const NOW = 1_000_000;
const FUTURE = NOW + 60_000;
const PAST = NOW - 60_000;

describe('threadStatusChip', () => {
	it('defaults an open thread to Open (success)', () => {
		expect(threadStatusChip({ status: 'open', now: NOW })).toEqual({
			label: 'Open',
			variant: 'success',
		});
	});

	it('draft_ready (latestDraftStatus pending) beats open', () => {
		expect(threadStatusChip({ status: 'open', latestDraftStatus: 'pending', now: NOW })).toEqual({
			label: 'Draft ready',
			variant: 'warning',
		});
	});

	it('snoozed beats both open and draft_ready', () => {
		expect(
			threadStatusChip({
				status: 'open',
				latestDraftStatus: 'pending',
				snoozedUntil: FUTURE,
				now: NOW,
			})
		).toEqual({ label: 'Snoozed', variant: 'info' });
	});

	it('resolved is terminal — outranks snooze and draft', () => {
		expect(
			threadStatusChip({
				status: 'resolved',
				latestDraftStatus: 'pending',
				snoozedUntil: FUTURE,
				now: NOW,
			})
		).toEqual({ label: 'Resolved', variant: 'muted' });
	});

	it('treats legacy closed as Resolved', () => {
		expect(threadStatusChip({ status: 'closed', now: NOW })).toEqual({
			label: 'Resolved',
			variant: 'muted',
		});
	});

	it('renders Waiting on them for a waiting thread with no draft', () => {
		expect(threadStatusChip({ status: 'waiting', now: NOW })).toEqual({
			label: 'Waiting on them',
			variant: 'muted',
		});
	});

	it('draft_ready outranks waiting', () => {
		expect(threadStatusChip({ status: 'waiting', latestDraftStatus: 'pending', now: NOW })).toEqual(
			{ label: 'Draft ready', variant: 'warning' }
		);
	});

	it('does not read a lapsed snooze as Snoozed', () => {
		expect(threadStatusChip({ status: 'open', snoozedUntil: PAST, now: NOW })).toEqual({
			label: 'Open',
			variant: 'success',
		});
	});

	it('ignores non-pending draft states', () => {
		expect(threadStatusChip({ status: 'open', latestDraftStatus: 'sent', now: NOW })).toEqual({
			label: 'Open',
			variant: 'success',
		});
	});
});

describe('threadChipDotClass', () => {
	it('maps each variant to a semantic dot token', () => {
		expect(threadChipDotClass('success')).toBe('bg-success');
		expect(threadChipDotClass('warning')).toBe('bg-warning');
		expect(threadChipDotClass('info')).toBe('bg-info');
		expect(threadChipDotClass('muted')).toBe('bg-text-tertiary');
	});
});
