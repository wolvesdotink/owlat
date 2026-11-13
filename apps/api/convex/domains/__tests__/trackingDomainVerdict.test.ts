/**
 * The tracking-domain verdict core (`domains/trackingDomainVerdict.ts`): which
 * outcome a check earns, how it lands on the row, and which tracking domain a
 * send uses. Plain objects in, plain plans out.
 */

import { describe, expect, it } from 'vitest';
import {
	planTrackingDomainCheck,
	selectTrackingDomainForSender,
	trackingDomainCheckOutcome,
} from '../trackingDomainVerdict';
import { REGRESSION_CONFIRM_DELAY_MS } from '../lifecycleVerdict';

const AT = Date.UTC(2026, 10, 1, 12, 0, 0);

describe('trackingDomainCheckOutcome', () => {
	it('verifies only when the CNAME matches and the probe answers', () => {
		expect(trackingDomainCheckOutcome('match', 'ok')).toBe('verified');
	});

	it('names the HTTPS half when the CNAME matches but the probe fails', () => {
		expect(trackingDomainCheckOutcome('match', 'unreachable')).toBe('https_unreachable');
		expect(trackingDomainCheckOutcome('match', 'wrong_response')).toBe('https_wrong_response');
	});

	it('names the DNS half when the CNAME is wrong, whatever the probe says', () => {
		expect(trackingDomainCheckOutcome('mismatch', null)).toBe('dns_mismatch');
		expect(trackingDomainCheckOutcome('mismatch', 'ok')).toBe('dns_mismatch');
	});

	it('is inconclusive when either lookup went unanswered', () => {
		expect(trackingDomainCheckOutcome('unanswered', null)).toBe('inconclusive');
		expect(trackingDomainCheckOutcome('match', 'unanswered')).toBe('inconclusive');
	});
});

describe('planTrackingDomainCheck', () => {
	const unverified = { isVerified: false, verifiedAt: undefined, regressionSuspectedAt: undefined };
	const verified = {
		isVerified: true,
		verifiedAt: AT - 86_400_000,
		regressionSuspectedAt: undefined,
	};

	it('leaves an unverified domain unverified when only the HTTPS half fails', () => {
		const plan = planTrackingDomainCheck(unverified, 'https_unreachable', AT);
		expect(plan.patch).toEqual({ lastCheck: { at: AT, outcome: 'https_unreachable' } });
		expect(plan.transition).toBeNull();
	});

	it('verifies an unverified domain on a passing check', () => {
		const plan = planTrackingDomainCheck(unverified, 'verified', AT);
		expect(plan.patch).toMatchObject({ isVerified: true, verifiedAt: AT });
		expect(plan.transition).toBe('verified');
	});

	it('keeps a verified domain verified on its first failure and asks for a confirming check', () => {
		const plan = planTrackingDomainCheck(verified, 'dns_mismatch', AT);
		expect(plan.patch).toEqual({
			lastCheck: { at: AT, outcome: 'dns_mismatch' },
			regressionSuspectedAt: AT,
		});
		expect(plan.transition).toBeNull();
		expect(plan.confirmAfterMs).toBe(REGRESSION_CONFIRM_DELAY_MS);
	});

	it('keeps the first stamp for a failure inside the confirmation window', () => {
		const suspected = { ...verified, regressionSuspectedAt: AT };
		const plan = planTrackingDomainCheck(suspected, 'https_unreachable', AT + 60_000);
		expect(plan.patch).not.toHaveProperty('isVerified');
		expect(plan.patch).not.toHaveProperty('regressionSuspectedAt');
		expect(plan.confirmAfterMs).toBeNull();
	});

	it('unverifies a verified domain on the confirming failure', () => {
		const suspected = { ...verified, regressionSuspectedAt: AT };
		const plan = planTrackingDomainCheck(
			suspected,
			'https_wrong_response',
			AT + REGRESSION_CONFIRM_DELAY_MS
		);
		expect(plan.patch).toMatchObject({ isVerified: false, regressionSuspectedAt: undefined });
		expect(plan.transition).toBe('unverified');
	});

	it('clears the suspicion when the confirming check passes, keeping the first verification time', () => {
		const suspected = { ...verified, regressionSuspectedAt: AT };
		const plan = planTrackingDomainCheck(suspected, 'verified', AT + REGRESSION_CONFIRM_DELAY_MS);
		expect(plan.patch).toMatchObject({
			isVerified: true,
			verifiedAt: verified.verifiedAt,
			regressionSuspectedAt: undefined,
		});
		expect(plan.transition).toBeNull();
	});

	it('changes nothing but the recorded check when the check is inconclusive', () => {
		const suspected = { ...verified, regressionSuspectedAt: AT };
		const plan = planTrackingDomainCheck(
			suspected,
			'inconclusive',
			AT + REGRESSION_CONFIRM_DELAY_MS
		);
		expect(plan.patch).toEqual({
			lastCheck: { at: AT + REGRESSION_CONFIRM_DELAY_MS, outcome: 'inconclusive' },
		});
		expect(plan.transition).toBeNull();
		expect(plan.confirmAfterMs).toBeNull();
	});
});

describe('selectTrackingDomainForSender', () => {
	const row = (domain: string, isVerified = true, createdAt = AT) => ({
		domain,
		isVerified,
		createdAt,
	});

	it('uses the verified tracking domain under the From address organisational domain', () => {
		expect(
			selectTrackingDomainForSender(
				[row('track.other.example'), row('links.example.com')],
				'News <news@mail.example.com>'
			)
		).toBe('links.example.com');
	});

	it("falls back to the default when only an unrelated domain's tracking host is verified", () => {
		expect(
			selectTrackingDomainForSender([row('track.other.example')], 'news@example.com')
		).toBeNull();
	});

	it('ignores an unverified tracking domain', () => {
		expect(
			selectTrackingDomainForSender([row('track.example.com', false)], 'a@example.com')
		).toBeNull();
	});

	it('does not join two tenants of a private suffix', () => {
		expect(
			selectTrackingDomainForSender([row('track.alice.github.io')], 'bob@bob.github.io')
		).toBeNull();
	});

	it('picks the oldest when several qualify', () => {
		expect(
			selectTrackingDomainForSender(
				[row('links.example.com', true, AT + 1), row('track.example.com', true, AT)],
				'a@example.com'
			)
		).toBe('track.example.com');
	});
});
