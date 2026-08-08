/**
 * P4-7 — EACH NEW SENDING SUBDOMAIN WARMS ON ITS OWN.
 *
 * Domain reputation is evaluated per FQDN and does not inherit from the root,
 * so a freshly created `news.example.com` starts from zero however long
 * `example.com` has been sending. The wizard says so, and the warming plan
 * behaves that way — a subdomain that inherited the root's warming progress
 * would be handed a daily cap it has earned no reputation for.
 */

import { describe, expect, it } from 'vitest';
import { BASE_WARMING_SCHEDULE, getWarmingCapForDay } from '@owlat/shared/warming';
import {
	planStreamSubdomains,
	planSubdomainWarming,
	type SubdomainLayoutInput,
	type SubdomainLayoutProposal,
} from '../streamSubdomains';

function layoutOf(input: SubdomainLayoutInput): SubdomainLayoutProposal {
	const result = planStreamSubdomains(input);
	if (!result.ok) throw new Error(`expected a layout for ${input.domain}`);
	return result.proposal;
}

const LAYOUT = layoutOf({ domain: 'example.com', sendingIps: ['203.0.113.10'] });

describe('one warming state per sending subdomain', () => {
	const plans = planSubdomainWarming(LAYOUT);

	it('covers every SENDING subdomain and nothing else', () => {
		expect(plans.map((p) => p.host)).toEqual(['mail.example.com', 'news.example.com']);
	});

	it('excludes the bounce host, which sends nothing and warms nothing', () => {
		expect(plans.some((p) => p.host === 'bounces.example.com')).toBe(false);
	});

	it('never inherits from the root', () => {
		for (const plan of plans) expect(plan.inheritsFromRoot).toBe(false);
	});

	it('starts every subdomain at day 1 of the published schedule', () => {
		for (const plan of plans) {
			expect(plan.startDay).toBe(1);
			expect(getWarmingCapForDay(plan.startDay)).toBe(BASE_WARMING_SCHEDULE[0]?.cap);
		}
	});

	it('gives the two subdomains SEPARATE states, not one shared state', () => {
		expect(new Set(plans.map((p) => p.host)).size).toBe(plans.length);
	});

	it('carries the pool each subdomain sends from', () => {
		expect(plans.find((p) => p.host === 'mail.example.com')?.pool).toBe('transactional');
		expect(plans.find((p) => p.host === 'news.example.com')?.pool).toBe('campaign');
	});

	it('attributes the streams that feed each subdomain’s warm-up', () => {
		expect(plans.find((p) => p.host === 'mail.example.com')?.streams).toEqual(['transactional']);
		// Campaign AND automation warm news. together — steady lifecycle volume is
		// the best warming fuel a bulk subdomain can get.
		expect(plans.find((p) => p.host === 'news.example.com')?.streams.sort()).toEqual([
			'automation',
			'campaign',
		]);
	});

	it('is the same on a single-IP deployment — warming is per NAME, not per IP', () => {
		const oneIp = planSubdomainWarming(
			layoutOf({ domain: 'example.com', sendingIps: ['203.0.113.10'] })
		);
		const noIp = planSubdomainWarming(layoutOf({ domain: 'example.com' }));
		expect(noIp).toEqual(oneIp);
	});

	it('works under a multi-label public suffix', () => {
		const uk = planSubdomainWarming(layoutOf({ domain: 'example.co.uk' }));
		expect(uk.map((p) => p.host)).toEqual(['mail.example.co.uk', 'news.example.co.uk']);
	});
});
