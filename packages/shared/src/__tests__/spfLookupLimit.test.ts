/**
 * The RFC 7208 10-lookup limit, and the SPF coexistence verdict shape.
 *
 * A merged record that needs an 11th DNS lookup PermErrors — which receivers
 * treat as an SPF failure for every sender at that host — so the merge must be
 * rejected BEFORE the ramp sends on both arms, and the rejection must name the
 * include to flatten.
 */

import { describe, expect, it } from 'vitest';
import {
	countSpfDnsLookups,
	evaluateSpfCoexistence,
	mechanismLookupCost,
	SPF_MAX_DNS_LOOKUPS,
} from '../spfCoexistence';

const OWN = 'ip4:203.0.113.10';
const RELAY = 'include:amazonses.com';

function published(...mechanisms: string[]): string {
	return `v=spf1 ${mechanisms.join(' ')} ~all`;
}

const NINE_LOOKUPS = [
	OWN,
	'include:a.example',
	'include:b.example',
	'include:c.example',
	'include:d.example',
	'include:e.example',
	'include:f.example',
	'include:g.example',
	'include:h.example',
	'include:i.example',
];

describe('lookup accounting', () => {
	it('counts exactly the terms RFC 7208 §4.6.4 charges for', () => {
		expect(mechanismLookupCost('ip4:203.0.113.10')).toBe(0);
		expect(mechanismLookupCost('ip6:2001:db8::1')).toBe(0);
		expect(mechanismLookupCost('~all')).toBe(0);
		expect(mechanismLookupCost('mx')).toBe(1);
		expect(mechanismLookupCost('a:mail.acme.com')).toBe(1);
		expect(mechanismLookupCost('exists:%{i}.acme.com')).toBe(1);
		expect(mechanismLookupCost('ptr')).toBe(1);
		expect(mechanismLookupCost('redirect=_spf.acme.com')).toBe(1);
		expect(mechanismLookupCost('include:amazonses.com')).toBe(1);
	});

	it('ignores the qualifier when costing a mechanism', () => {
		expect(mechanismLookupCost('+include:amazonses.com')).toBe(1);
		expect(mechanismLookupCost('-ip4:203.0.113.10')).toBe(0);
	});

	it('sums a whole record', () => {
		expect(countSpfDnsLookups(published(...NINE_LOOKUPS))).toBe(9);
		expect(SPF_MAX_DNS_LOOKUPS).toBe(10);
	});
});

describe('a merged record inside the limit', () => {
	it('passes and reports the merged record and its lookup count', () => {
		const result = evaluateSpfCoexistence({
			publishedTxtRecords: [published(OWN, RELAY)],
			requiredMechanisms: [OWN, RELAY],
		});
		expect(result.kind).toBe('pass');
		if (result.kind !== 'pass') throw new Error('expected a pass');
		expect(result.lookupCount).toBe(1);
		expect(result.mergedRecord).toContain(OWN);
		expect(result.mergedRecord).toContain(RELAY);
	});
});

describe('the merged record is rejected when the relay include pushes it past 10', () => {
	it('names the include to flatten', () => {
		// 10 lookups published; adding the relay's include makes 11.
		const result = evaluateSpfCoexistence({
			publishedTxtRecords: [published(...NINE_LOOKUPS, 'include:j.example')],
			requiredMechanisms: [OWN, RELAY],
		});
		expect(result.kind).toBe('lookup_limit');
		if (result.kind !== 'lookup_limit') throw new Error('expected a lookup_limit');
		expect(result.lookupCount).toBe(11);
		// Never one of the two arms' own mechanisms — flattening those would
		// remove the arm the ramp is measuring.
		expect(result.flattenCandidate).toBe('include:j.example');
	});

	it('reports the limit ahead of a missing mechanism, since adding it cannot help', () => {
		const result = evaluateSpfCoexistence({
			publishedTxtRecords: [published(...NINE_LOOKUPS, 'include:j.example', 'include:k.example')],
			requiredMechanisms: [OWN, RELAY],
		});
		expect(result.kind).toBe('lookup_limit');
	});

	it('offers no candidate when every include is essential', () => {
		const essentialIncludes = Array.from(
			{ length: 11 },
			(_, index) => `include:arm${index}.example`
		);
		const result = evaluateSpfCoexistence({
			publishedTxtRecords: [published(...essentialIncludes)],
			requiredMechanisms: essentialIncludes,
		});
		expect(result.kind).toBe('lookup_limit');
		if (result.kind !== 'lookup_limit') throw new Error('expected a lookup_limit');
		expect(result.flattenCandidate).toBeNull();
	});
});

describe('the other failure variants carry only what they mean', () => {
	it('no_record lists every required mechanism as missing', () => {
		const result = evaluateSpfCoexistence({
			publishedTxtRecords: ['v=DMARC1; p=none'],
			requiredMechanisms: [OWN, RELAY],
		});
		expect(result.kind).toBe('no_record');
		if (result.kind !== 'no_record') throw new Error('expected no_record');
		expect(result.missingMechanisms).toEqual([OWN, RELAY]);
	});

	it('multiple_records counts them', () => {
		const result = evaluateSpfCoexistence({
			publishedTxtRecords: [published(OWN), published(RELAY)],
			requiredMechanisms: [OWN, RELAY],
		});
		expect(result.kind).toBe('multiple_records');
		if (result.kind !== 'multiple_records') throw new Error('expected multiple_records');
		expect(result.recordCount).toBe(2);
	});

	it('accepts an explicit + qualifier, which has the same pass semantics as the default', () => {
		const result = evaluateSpfCoexistence({
			publishedTxtRecords: [published(`+${OWN}`)],
			requiredMechanisms: [OWN, RELAY],
		});
		expect(result.kind).toBe('missing_mechanism');
		if (result.kind !== 'missing_mechanism') throw new Error('expected missing_mechanism');
		expect(result.missingMechanisms).toEqual([RELAY]);
	});

	// COSTING is qualifier-insensitive; AUTHORIZATION is not. `-ip4:…`, `~include:…`
	// and `?ip4:…` match the same senders and cost the same lookup, but they are the
	// OPPOSITE of an authorization — a record that names both arms negatively
	// SPF-FAILS both of them, so it must never read as covering them.
	for (const qualifier of ['-', '~', '?'] as const) {
		it(`treats a ${qualifier}-qualified mechanism as absent, not as authorization`, () => {
			const result = evaluateSpfCoexistence({
				publishedTxtRecords: [published(`${qualifier}${OWN}`, `${qualifier}${RELAY}`)],
				requiredMechanisms: [OWN, RELAY],
			});
			expect(result.kind).toBe('missing_mechanism');
			if (result.kind !== 'missing_mechanism') throw new Error('expected missing_mechanism');
			expect(result.missingMechanisms).toEqual([OWN, RELAY]);
		});
	}

	it('still COSTS a negatively-qualified include its DNS lookup', () => {
		// Ten negative includes plus the relay's own: over the limit, even though not
		// one of them authorizes anybody.
		const negatives = Array.from({ length: 10 }, (_, index) => `-include:n${index}.example`);
		const result = evaluateSpfCoexistence({
			publishedTxtRecords: [published(...negatives, OWN)],
			requiredMechanisms: [OWN, RELAY],
		});
		expect(result.kind).toBe('lookup_limit');
		if (result.kind !== 'lookup_limit') throw new Error('expected a lookup_limit');
		expect(result.lookupCount).toBe(11);
	});
});
