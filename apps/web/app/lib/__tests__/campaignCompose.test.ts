import { describe, expect, it } from 'vitest';
import {
	campaignReturnTarget,
	campaignReviewPath,
	emailEditorPath,
	readReviewSchedule,
	templateHasBody,
} from '../campaignCompose';

describe('templateHasBody', () => {
	it('needs stored HTML, the thing the send pipeline refuses without', () => {
		expect(templateHasBody(null)).toBe(false);
		expect(templateHasBody({})).toBe(false);
		expect(templateHasBody({ htmlContent: '   ' })).toBe(false);
		expect(templateHasBody({ htmlContent: '<p>Hi</p>' })).toBe(true);
	});

	it('treats a canvas saved with no blocks as empty, whatever wrapper it rendered', () => {
		expect(templateHasBody({ htmlContent: '<html><body></body></html>', content: '[]' })).toBe(
			false
		);
		expect(
			templateHasBody({ htmlContent: '<p>Hi</p>', content: '[{"id":"b1","type":"text"}]' })
		).toBe(true);
	});
});

describe('campaign ↔ editor round trip', () => {
	it('points the editor back at the draft’s Review step', () => {
		const back = campaignReviewPath('cmp1');
		expect(back).toBe('/dashboard/campaigns/new?id=cmp1&step=review');
		expect(emailEditorPath('tpl1', back)).toBe(
			`/dashboard/send/emails/tpl1/edit?returnTo=${encodeURIComponent(back)}`
		);
	});

	it('opens the editor on one Block when a pre-send finding points at it', () => {
		const back = campaignReviewPath('cmp1');
		const path = emailEditorPath('tpl1', back, 'block/7');
		const query = new URL(path, 'https://owlat.example').searchParams;
		expect(query.get('block')).toBe('block/7');
		expect(query.get('returnTo')).toBe(back);
	});

	it('carries a pending schedule there and back', () => {
		const back = campaignReviewPath('cmp1', {
			date: '2026-10-05',
			time: '09:30',
			recipientTimezone: true,
		});
		const query = Object.fromEntries(new URL(back, 'https://owlat.example').searchParams);
		expect(query).toMatchObject({ id: 'cmp1', step: 'review', send: 'later' });
		expect(readReviewSchedule(query)).toEqual({
			date: '2026-10-05',
			time: '09:30',
			recipientTimezone: true,
		});
	});

	it('carries an "Optimized per contact" choice there and back', () => {
		const schedule = {
			date: '2026-10-05',
			time: '09:30',
			recipientTimezone: false,
			optimization: { windowHours: 24, holdoutPercent: 10 },
		};
		const back = campaignReviewPath('cmp1', schedule);
		const query = Object.fromEntries(new URL(back, 'https://owlat.example').searchParams);
		expect(query['sto']).toBe('24-10');
		expect(readReviewSchedule(query)).toEqual(schedule);
		expect(readReviewSchedule({ ...query, sto: '24' })).not.toHaveProperty('optimization');
	});

	it('reads no schedule from a plain link, and drops malformed values', () => {
		expect(readReviewSchedule({ id: 'cmp1', step: 'review' })).toBeNull();
		expect(readReviewSchedule({ send: 'later', date: 'tomorrow', time: '9' })).toEqual({
			date: '',
			time: '',
			recipientTimezone: false,
		});
	});

	it('only honours a same-origin campaign path as the way back', () => {
		expect(campaignReturnTarget('/dashboard/campaigns/new?id=cmp1&step=review')).toBe(
			'/dashboard/campaigns/new?id=cmp1&step=review'
		);
		expect(campaignReturnTarget(['/dashboard/campaigns/new?id=cmp1'])).toBe(
			'/dashboard/campaigns/new?id=cmp1'
		);
		expect(campaignReturnTarget('https://evil.example/dashboard/campaigns/')).toBeNull();
		expect(campaignReturnTarget('//evil.example/dashboard/campaigns/')).toBeNull();
		expect(campaignReturnTarget('/dashboard/settings')).toBeNull();
		expect(campaignReturnTarget(undefined)).toBeNull();
	});
});
