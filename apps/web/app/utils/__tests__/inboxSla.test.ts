/**
 * Team Inbox response targets on the web side: the row chip, the analytics
 * duration and range helpers, and the settings form conversions.
 */
import { describe, expect, it } from 'vitest';
import {
	INBOX_SLA_DUE_SOON_MS,
	inboxAnalyticsRange,
	inboxSlaChip,
	inboxSlaDurationLabel,
} from '../inboxSla';
import {
	clockToMinutes,
	formToPolicy,
	minutesToClock,
	policyFormProblem,
	policyToForm,
	targetToParts,
	DEFAULT_SLA_FORM_POLICY,
} from '../inboxSlaPolicyForm';
import { availableInboxSorts, nextInboxSort, parseInboxFilter } from '../inboxFilters';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('inboxSlaChip', () => {
	const now = 1_000_000_000;

	it('mirrors the backend due-soon window', () => {
		// apps/api/convex/inbox/sla/slices.ts SLA_DUE_SOON_MS
		expect(INBOX_SLA_DUE_SOON_MS).toBe(HOUR);
	});

	it('has no chip without a running deadline', () => {
		expect(inboxSlaChip({}, now)).toBeNull();
		expect(inboxSlaChip({ responseDueAt: null }, now)).toBeNull();
	});

	it('tiers by distance to the deadline', () => {
		expect(inboxSlaChip({ responseDueAt: now + 2 * HOUR }, now)).toEqual({
			tier: 'ok',
			label: { key: 'shared.inboxSla.dueIn.hours', params: { hours: 2 } },
		});
		expect(inboxSlaChip({ responseDueAt: now + HOUR }, now)?.tier).toBe('soon');
		expect(inboxSlaChip({ responseDueAt: now }, now)).toEqual({
			tier: 'overdue',
			label: { key: 'shared.inboxSla.overdue.minutes', params: { minutes: 0 } },
		});
		expect(inboxSlaChip({ responseDueAt: now - DAY - 3 * HOUR }, now)?.label).toEqual({
			key: 'shared.inboxSla.overdue.daysHours',
			params: { days: 1, hours: 3 },
		});
	});
});

describe('inboxSlaDurationLabel', () => {
	it('reads one unit finer than the chip', () => {
		expect(inboxSlaDurationLabel(45 * MINUTE).params).toEqual({ minutes: 45 });
		expect(inboxSlaDurationLabel(2 * HOUR + 13 * MINUTE)).toEqual({
			key: 'shared.inboxSla.duration.hoursMinutes',
			params: { hours: 2, minutes: 13 },
		});
		expect(inboxSlaDurationLabel(59.6 * MINUTE).params).toEqual({ hours: 1, minutes: 0 });
		expect(inboxSlaDurationLabel(3 * DAY + 4 * HOUR).params).toEqual({ days: 3, hours: 4 });
	});
});

describe('inboxAnalyticsRange', () => {
	const now = Date.parse('2026-10-02T12:00:00Z');

	it('ends a preset today', () => {
		expect(inboxAnalyticsRange('7', { from: '', to: '' }, now)).toEqual({
			fromDay: '2026-09-26',
			toDay: '2026-10-02',
		});
	});

	it('accepts a custom range and refuses a reversed, empty or over-long one', () => {
		expect(inboxAnalyticsRange('custom', { from: '2026-01-01', to: '2026-01-31' }, now)).toEqual({
			fromDay: '2026-01-01',
			toDay: '2026-01-31',
		});
		expect(inboxAnalyticsRange('custom', { from: '2026-02-01', to: '2026-01-01' }, now)).toBeNull();
		expect(inboxAnalyticsRange('custom', { from: '', to: '2026-01-01' }, now)).toBeNull();
		expect(inboxAnalyticsRange('custom', { from: '2024-01-01', to: '2026-01-01' }, now)).toBeNull();
	});
});

describe('settings form conversions', () => {
	it('states a target in its largest exact unit', () => {
		expect(targetToParts(240)).toEqual({ amount: 4, unit: 'hours' });
		expect(targetToParts(2880)).toEqual({ amount: 2, unit: 'days' });
		expect(targetToParts(90)).toEqual({ amount: 90, unit: 'minutes' });
	});

	it('reads an end of 00:00 as midnight', () => {
		expect(clockToMinutes('00:00', true)).toBe(1440);
		expect(clockToMinutes('00:00')).toBe(0);
		expect(minutesToClock(1440)).toBe('00:00');
		expect(minutesToClock(17 * 60 + 30)).toBe('17:30');
	});

	it('round-trips a policy and drops closed days', () => {
		const policy = {
			...DEFAULT_SLA_FORM_POLICY,
			timeZone: 'Europe/Berlin',
			holidays: ['2026-12-25'],
		};
		expect(formToPolicy(policyToForm(policy))).toEqual(policy);
		const form = policyToForm(policy);
		form.days[0]!.isOpen = false; // Monday
		expect(formToPolicy(form).businessHours.map((h) => h.day)).toEqual([2, 3, 4, 5]);
	});

	it('names the problem as a catalog key', () => {
		const ok = DEFAULT_SLA_FORM_POLICY;
		expect(policyFormProblem(ok)).toBeNull();
		expect(policyFormProblem({ ...ok, firstResponseMinutes: 0 })).toContain('problems.target');
		expect(policyFormProblem({ ...ok, timeZone: 'Nowhere/Land' })).toContain('problems.timeZone');
		expect(
			policyFormProblem({ ...ok, businessHours: [{ day: 1, start: 600, end: 540 }] })
		).toContain('problems.hours');
		expect(policyFormProblem({ ...ok, businessHours: [] })).toContain('problems.noOpenDay');
		expect(policyFormProblem({ ...ok, hoursMode: 'calendar', businessHours: [] })).toBeNull();
	});
});

describe('inbox filters and sorts', () => {
	it('accepts the response-target slices from the URL', () => {
		expect(parseInboxFilter('sla-overdue')).toBe('sla-overdue');
		expect(parseInboxFilter('sla-due-soon')).toBe('sla-due-soon');
	});

	it('offers the due order only while targets are on', () => {
		expect(availableInboxSorts(false)).not.toContain('due');
		expect(nextInboxSort('oldest-waiting')).toBe('newest');
		expect(nextInboxSort('oldest-waiting', true)).toBe('due');
		expect(nextInboxSort('due', true)).toBe('newest');
	});
});
