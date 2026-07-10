/**
 * Campaign attention classifier (utils/campaignAttention):
 *   - precedence: A/B decision > needs review > send stopped > scheduled today
 *   - draft / sent / plain-scheduled-future campaigns do NOT need attention
 *   - overdue-but-still-scheduled surfaces as "going out today"
 *   - each attention bucket carries the right inline action label.
 */
import { describe, it, expect } from 'vitest';
import { classifyCampaignAttention } from '../campaignAttention';

// A fixed clock at midday so "today" boundaries are unambiguous.
const NOW = new Date('2026-07-07T12:00:00').getTime();
const LATER_TODAY = new Date('2026-07-07T18:00:00').getTime();
const OVERDUE = new Date('2026-07-07T09:00:00').getTime();
const TOMORROW = new Date('2026-07-08T09:00:00').getTime();

describe('classifyCampaignAttention', () => {
	it('a plain draft needs no attention', () => {
		const r = classifyCampaignAttention({ status: 'draft', now: NOW });
		expect(r.needsAttention).toBe(false);
		expect(r.reason).toBeNull();
		expect(r.actionLabel).toBeNull();
	});

	it('a sent campaign needs no attention', () => {
		expect(classifyCampaignAttention({ status: 'sent', now: NOW }).needsAttention).toBe(false);
	});

	it('an A/B test still testing with no winner asks to Pick winner', () => {
		const r = classifyCampaignAttention({
			status: 'sending',
			isABTest: true,
			abTestStatus: 'testing',
			abWinner: null,
			now: NOW,
		});
		expect(r).toEqual({ needsAttention: true, reason: 'ab_decision', actionLabel: 'Pick winner' });
	});

	it('an A/B test with a declared winner no longer needs the decision', () => {
		const r = classifyCampaignAttention({
			status: 'sent',
			isABTest: true,
			abTestStatus: 'winner_selected',
			abWinner: 'B',
			now: NOW,
		});
		expect(r.needsAttention).toBe(false);
	});

	it('a not-yet-started A/B draft does not ask to pick a winner', () => {
		const r = classifyCampaignAttention({
			status: 'draft',
			isABTest: true,
			abTestStatus: 'testing',
			now: NOW,
		});
		expect(r.needsAttention).toBe(false);
	});

	it('a pending_review campaign asks for Review', () => {
		const r = classifyCampaignAttention({ status: 'pending_review', now: NOW });
		expect(r).toEqual({ needsAttention: true, reason: 'needs_review', actionLabel: 'Review' });
	});

	it('a draft with blocked content asks for Review', () => {
		const r = classifyCampaignAttention({
			status: 'draft',
			contentBlockReason: 'flagged phrase',
			now: NOW,
		});
		expect(r.reason).toBe('needs_review');
	});

	it('a sent campaign with a stale block reason does not re-open for review', () => {
		const r = classifyCampaignAttention({
			status: 'sent',
			contentBlockReason: 'flagged phrase',
			now: NOW,
		});
		expect(r.needsAttention).toBe(false);
	});

	it('a cancelled send asks to Resume', () => {
		const r = classifyCampaignAttention({ status: 'cancelled', now: NOW });
		expect(r).toEqual({ needsAttention: true, reason: 'send_stopped', actionLabel: 'Resume' });
	});

	it('a campaign scheduled later today surfaces without an inline action', () => {
		const r = classifyCampaignAttention({
			status: 'scheduled',
			scheduledAt: LATER_TODAY,
			now: NOW,
		});
		expect(r).toEqual({ needsAttention: true, reason: 'scheduled_today', actionLabel: null });
	});

	it('an overdue-but-still-scheduled campaign surfaces as going out today', () => {
		const r = classifyCampaignAttention({
			status: 'scheduled',
			scheduledAt: OVERDUE,
			now: NOW,
		});
		expect(r.reason).toBe('scheduled_today');
	});

	it('a campaign scheduled for a future day needs no attention', () => {
		const r = classifyCampaignAttention({
			status: 'scheduled',
			scheduledAt: TOMORROW,
			now: NOW,
		});
		expect(r.needsAttention).toBe(false);
	});

	it('A/B decision outranks a same-day schedule', () => {
		const r = classifyCampaignAttention({
			status: 'scheduled',
			scheduledAt: LATER_TODAY,
			isABTest: true,
			abTestStatus: 'testing',
			abWinner: null,
			now: NOW,
		});
		expect(r.reason).toBe('ab_decision');
	});

	it('needs-review outranks send-stopped when both could apply', () => {
		const r = classifyCampaignAttention({
			status: 'pending_review',
			contentBlockReason: 'flagged',
			now: NOW,
		});
		expect(r.reason).toBe('needs_review');
	});
});
