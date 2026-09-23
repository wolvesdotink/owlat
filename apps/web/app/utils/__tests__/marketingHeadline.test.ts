import { describe, expect, it } from 'vitest';
import {
	averageRates,
	bestRun,
	campaignHeadline,
	headlineVerdict,
	pointsDelta,
	ratesOf,
	reportHeadline,
	type RatedCampaign,
} from '../marketingHeadline';

function c(id: string, openRate: number, clickRate: number, unsubscribeRate = 0): RatedCampaign {
	return { id, openRate, clickRate, unsubscribeRate };
}

const AVG = { openRate: 0.4, clickRate: 0.05, unsubscribeRate: 0.002 };

describe('bestRun', () => {
	it('counts back until an earlier campaign did better, the target included', () => {
		const history = [c('a', 0.5, 0.09), c('b', 0.4, 0.03), c('c', 0.4, 0.04), c('d', 0.4, 0.06)];
		expect(bestRun(history, 3, 'clickRate')).toBe(3);
		expect(bestRun(history, 3, 'openRate')).toBe(3);
		expect(bestRun(history, 0, 'clickRate')).toBe(1);
	});

	it('counts ties as not beaten', () => {
		expect(bestRun([c('a', 0.4, 0.05), c('b', 0.4, 0.05)], 1, 'clickRate')).toBe(2);
	});
});

describe('headlineVerdict', () => {
	it('has nothing to say for a first send or an unknown campaign', () => {
		expect(headlineVerdict('a', [c('a', 0.4, 0.05)], AVG)).toBeNull();
		expect(headlineVerdict('x', [c('a', 0.4, 0.05), c('b', 0.4, 0.05)], AVG)).toBeNull();
	});

	it('leads with a click record of at least three campaigns', () => {
		const history = [c('a', 0.6, 0.02), c('b', 0.5, 0.03), c('c', 0.3, 0.04)];
		expect(headlineVerdict('c', history, AVG)).toEqual({ kind: 'bestClick', count: 3 });
	});

	it('falls back to an open record when clicks set none', () => {
		const history = [c('a', 0.2, 0.09), c('b', 0.3, 0.08), c('c', 0.45, 0.05)];
		expect(headlineVerdict('c', history, AVG)).toEqual({ kind: 'bestOpen', count: 3 });
	});

	it('never claims a record for a zero rate', () => {
		const history = [c('a', 0, 0), c('b', 0, 0), c('c', 0, 0)];
		expect(headlineVerdict('c', history, AVG)?.kind).toBe('belowOpen');
	});

	it('warns about unsubscribes at twice the average', () => {
		const history = [c('a', 0.5, 0.09), c('b', 0.4, 0.05, 0.01)];
		expect(headlineVerdict('b', history, AVG)).toEqual({ kind: 'highUnsubscribe' });
	});

	it('names a gap to the average, below before above', () => {
		const top = c('top', 0.9, 0.9);
		expect(headlineVerdict('b', [top, c('b', 0.3, 0.09)], AVG)?.kind).toBe('belowOpen');
		expect(headlineVerdict('b', [top, c('b', 0.4, 0.03)], AVG)?.kind).toBe('belowClick');
		expect(headlineVerdict('b', [top, c('b', 0.45, 0.05)], AVG)?.kind).toBe('aboveOpen');
		expect(headlineVerdict('b', [top, c('b', 0.4, 0.07)], AVG)?.kind).toBe('aboveClick');
		expect(headlineVerdict('b', [top, c('b', 0.41, 0.051)], AVG)?.kind).toBe('onPar');
	});
});

describe('campaignHeadline / reportHeadline', () => {
	const history = [c('a', 0.6, 0.02), c('b', 0.5, 0.03), c('c', 0.3, 0.04)];

	it('turns the verdict into a card message key with its count', () => {
		expect(campaignHeadline('c', history, AVG)).toEqual({
			key: 'components.marketing.headline.bestClick',
			params: { count: 3 },
		});
		expect(campaignHeadline('c', [c('c', 0.3, 0.04)], AVG)).toBeNull();
	});

	it('always states the rates in the report sentence', () => {
		expect(reportHeadline('c', history, AVG, { open: '30%', click: '4%' })).toEqual({
			key: 'components.campaigns.reportHeadline.bestClick',
			params: { count: 3, open: '30%', click: '4%' },
		});
		expect(reportHeadline('c', [], AVG, { open: '30%', click: '4%' })).toEqual({
			key: 'components.campaigns.reportHeadline.none',
			params: { open: '30%', click: '4%' },
		});
	});
});

describe('rate helpers', () => {
	it('computes rates over delivered, 0 when nothing was delivered', () => {
		expect(ratesOf({ delivered: 200, opened: 80, clicked: 10, unsubscribed: 2 })).toEqual({
			openRate: 0.4,
			clickRate: 0.05,
			unsubscribeRate: 0.01,
		});
		expect(ratesOf({ delivered: 0, opened: 3, clicked: 1, unsubscribed: 0 }).openRate).toBe(0);
	});

	it('weights the average by delivered', () => {
		const avg = averageRates([
			{ delivered: 10, opened: 10, clicked: 0, unsubscribed: 0 },
			{ delivered: 990, opened: 198, clicked: 0, unsubscribed: 0 },
		]);
		expect(avg.openRate).toBeCloseTo(0.208, 6);
	});

	it('formats a signed point delta', () => {
		expect(pointsDelta(0.431, 0.4)).toEqual({ text: '+3.1', sign: 1 });
		expect(pointsDelta(0.396, 0.4)).toEqual({ text: '−0.4', sign: -1 });
		expect(pointsDelta(0.4, 0.4)).toEqual({ text: '0.0', sign: 0 });
	});
});
