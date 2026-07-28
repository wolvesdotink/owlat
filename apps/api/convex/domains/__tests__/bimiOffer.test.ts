/**
 * P4-7 — BIMI is OFFERED at p=quarantine or stricter, carries the VMC note,
 * and is NEVER a nag (D2).
 */

import { describe, expect, it } from 'vitest';
import { DMARC_POLICIES, type DmarcPolicy } from '../dmarc';
import {
	BIMI_DEFAULT_SELECTOR,
	BIMI_MIN_DMARC_POLICY,
	BIMI_VMC_NOTE,
	BIMI_VMC_REQUIRED_RECEIVERS,
	bimiIneligibleReason,
	isBimiEligible,
	offerBimiRecord,
} from '../bimi';

const LOGO = 'https://example.com/logo.svg';
const VMC = 'https://example.com/vmc.pem';

describe('the DMARC precondition', () => {
	it('is quarantine or stricter', () => {
		expect(BIMI_MIN_DMARC_POLICY).toBe('quarantine');
		expect(isBimiEligible({ dmarcPolicy: 'quarantine' })).toBe(true);
		expect(isBimiEligible({ dmarcPolicy: 'reject' })).toBe(true);
		expect(isBimiEligible({ dmarcPolicy: 'none' })).toBe(false);
		// A legacy row with no policy at all is monitor-only.
		expect(isBimiEligible({})).toBe(false);
	});

	it('covers every shipped policy value exhaustively', () => {
		const eligible = DMARC_POLICIES.filter((policy: DmarcPolicy) =>
			isBimiEligible({ dmarcPolicy: policy })
		);
		expect([...eligible]).toEqual(['quarantine', 'reject']);
	});

	it('a staged pct below 100 leaves mail unenforced, so BIMI waits', () => {
		expect(bimiIneligibleReason({ dmarcPolicy: 'quarantine', dmarcPct: 50 })).toBe(
			'dmarc_pct_below_100'
		);
		expect(isBimiEligible({ dmarcPolicy: 'quarantine', dmarcPct: 100 })).toBe(true);
	});
});

describe('at p=none the offer is silent', () => {
	const offer = offerBimiRecord({ domain: 'news.example.com', dmarcPolicy: 'none', logoUrl: LOGO });

	it('is not offered and emits no record', () => {
		expect(offer.offered).toBe(false);
		expect(offer.record).toBeNull();
		expect(offer.ineligibleReason).toBe('dmarc_policy_below_quarantine');
	});

	it('is not a nag: no note, not required, never a task', () => {
		expect(offer.vmcNote).toBeNull();
		expect(offer.required).toBe(false);
		expect(offer.nag).toBe(false);
	});
});

describe('at p=quarantine the offer is made', () => {
	const offer = offerBimiRecord({
		domain: 'news.example.com',
		dmarcPolicy: 'quarantine',
		logoUrl: LOGO,
	});

	it('offers the record at the default selector', () => {
		expect(offer.offered).toBe(true);
		expect(offer.ineligibleReason).toBeNull();
		expect(BIMI_DEFAULT_SELECTOR).toBe('default');
		expect(offer.record?.host).toBe('default._bimi.news.example.com');
		expect(offer.record?.relativeHost).toBe('default._bimi.news');
		expect(offer.record?.value).toBe(`v=BIMI1; l=${LOGO};`);
	});

	it('states plainly that a VMC is required for Gmail and Apple', () => {
		expect(offer.vmcNote).toBe(BIMI_VMC_NOTE);
		expect(offer.vmcNote).toMatch(/VMC/);
		expect([...BIMI_VMC_REQUIRED_RECEIVERS]).toEqual(['gmail', 'apple']);
		expect(offer.vmcNote).toMatch(/Gmail/);
		expect(offer.vmcNote).toMatch(/Apple/);
	});

	it('is still never required and never a nag', () => {
		expect(offer.required).toBe(false);
		expect(offer.nag).toBe(false);
	});

	it('adds a= only once a VMC has actually been bought', () => {
		const withVmc = offerBimiRecord({
			domain: 'news.example.com',
			dmarcPolicy: 'reject',
			logoUrl: LOGO,
			vmcUrl: VMC,
		});
		expect(withVmc.record?.value).toBe(`v=BIMI1; l=${LOGO}; a=${VMC};`);
	});

	it('asks for a logo instead of emitting an empty l=', () => {
		const noLogo = offerBimiRecord({ domain: 'news.example.com', dmarcPolicy: 'reject' });
		expect(noLogo.offered).toBe(true);
		expect(noLogo.record).toBeNull();
		expect(noLogo.vmcNote).toBe(BIMI_VMC_NOTE);
	});

	it('honours a custom selector and ignores a blank one', () => {
		const custom = offerBimiRecord({
			domain: 'news.example.com',
			dmarcPolicy: 'reject',
			logoUrl: LOGO,
			selector: 'brand',
		});
		expect(custom.record?.host).toBe('brand._bimi.news.example.com');
		const blank = offerBimiRecord({
			domain: 'news.example.com',
			dmarcPolicy: 'reject',
			logoUrl: LOGO,
			selector: '   ',
		});
		expect(blank.record?.host).toBe('default._bimi.news.example.com');
	});

	it('a selector that is not a DNS label falls back rather than throwing', () => {
		// The selector is interpolated into a record host, and this is a RENDERING
		// surface: a value that cannot name anything degrades to the spec default
		// instead of taking down the screen the operator would use to fix it.
		for (const selector of ['bad selector', 'a/b', '-leading', 'trailing-', 'x'.repeat(64)]) {
			const offer = offerBimiRecord({
				domain: 'news.example.com',
				dmarcPolicy: 'reject',
				logoUrl: LOGO,
				selector,
			});
			expect(offer.record?.host).toBe('default._bimi.news.example.com');
			expect(offer.record?.relativeHost).toBe('default._bimi.news');
		}
	});

	it('a domain with no registrable zone shows the absolute host, never a throw', () => {
		const offer = offerBimiRecord({
			domain: 'localhost',
			dmarcPolicy: 'reject',
			logoUrl: LOGO,
		});
		expect(offer.record?.host).toBe('default._bimi.localhost');
		expect(offer.record?.relativeHost).toBe('default._bimi.localhost');
	});
});

describe('D2 — BIMI never blocks anything', () => {
	it('no shape of the offer is ever required or a nag', () => {
		const shapes = [
			offerBimiRecord({ domain: 'mail.example.com', dmarcPolicy: 'none' }),
			offerBimiRecord({ domain: 'mail.example.com', dmarcPolicy: 'quarantine', dmarcPct: 10 }),
			offerBimiRecord({ domain: 'mail.example.com', dmarcPolicy: 'reject' }),
			offerBimiRecord({ domain: 'mail.example.com', dmarcPolicy: 'reject', logoUrl: LOGO }),
		];
		for (const shape of shapes) {
			expect(shape.required).toBe(false);
			expect(shape.nag).toBe(false);
		}
	});

	it('a missing VMC is a note, not an error state', () => {
		const offer = offerBimiRecord({
			domain: 'mail.example.com',
			dmarcPolicy: 'reject',
			logoUrl: LOGO,
		});
		expect(offer.record?.value.includes('a=')).toBe(false);
		expect(offer.ineligibleReason).toBeNull();
	});
});
