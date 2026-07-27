/**
 * The RFC 7208 §4.6.4 10-lookup limit: the merged record is REJECTED when
 * adding the relay's include pushes it past 10 lookups, and the failure names
 * which include to flatten.
 *
 * The 11th lookup term is a PermError, which receivers treat as an SPF failure
 * for every sender on the domain — so this has to be caught before the ramp
 * turns both arms on, not after.
 */

import { describe, expect, it } from 'vitest';
import {
	countSpfDnsLookups,
	evaluateSpfCoexistence,
	mechanismLookupCost,
	SPF_MAX_DNS_LOOKUPS,
} from '../spfCoexistence';
import { ALIGNMENT_REMEDIES, evaluateAlignmentPreflight } from '../deliverabilityAlignment';
import {
	alignedDns,
	alignedInput,
	found,
	OWN_SPF_MECHANISM,
	RELAY_SPF_MECHANISM,
} from './alignmentFixtures';

/** Nine lookup terms: eight includes plus `mx`. */
const NINE_LOOKUPS = [
	'include:a.example',
	'include:b.example',
	'include:c.example',
	'include:d.example',
	'include:e.example',
	'include:f.example',
	'include:g.example',
	'include:h.example',
	'mx',
];

function published(mechanisms: readonly string[]): string {
	return `v=spf1 ${OWN_SPF_MECHANISM} ${mechanisms.join(' ')} ~all`;
}

describe('lookup counting', () => {
	it('counts only the terms that cost a DNS lookup', () => {
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

	it('honours a declared nested cost for a known include target', () => {
		expect(mechanismLookupCost('include:_spf.google.com', { '_spf.google.com': 4 })).toBe(4);
		// A hostile or nonsensical declared cost never counts as less than the
		// one lookup the include itself always performs.
		expect(mechanismLookupCost('include:x.example', { 'x.example': Number.NaN })).toBe(1);
		expect(mechanismLookupCost('include:x.example', { 'x.example': -8 })).toBe(1);
	});

	it('counts a whole record', () => {
		expect(countSpfDnsLookups(published(NINE_LOOKUPS))).toBe(9);
	});
});

describe('the merged record is accepted at exactly the limit', () => {
	const result = evaluateSpfCoexistence({
		publishedTxtRecords: [published([...NINE_LOOKUPS, RELAY_SPF_MECHANISM])],
		requiredMechanisms: [OWN_SPF_MECHANISM, RELAY_SPF_MECHANISM],
	});

	it('passes at 10 lookups', () => {
		expect(result.status).toBe('pass');
		expect(result.lookupCount).toBe(SPF_MAX_DNS_LOOKUPS);
		expect(result.mergedRecord).toContain(RELAY_SPF_MECHANISM);
		expect(result.flattenCandidate).toBeNull();
	});
});

describe('the merged record is rejected one lookup over the limit', () => {
	const result = evaluateSpfCoexistence({
		publishedTxtRecords: [published([...NINE_LOOKUPS, RELAY_SPF_MECHANISM, 'include:i.example'])],
		requiredMechanisms: [OWN_SPF_MECHANISM, RELAY_SPF_MECHANISM],
		essentialMechanisms: [OWN_SPF_MECHANISM, RELAY_SPF_MECHANISM],
	});

	it('fails with the lookup-limit reason and the measured count', () => {
		expect(result.status).toBe('fail');
		expect(result.reason).toBe('lookup_limit');
		expect(result.lookupCount).toBe(11);
	});

	it('names an include to flatten, never one of the two arms', () => {
		expect(result.flattenCandidate).toBe('include:i.example');
		expect(result.flattenCandidate).not.toBe(RELAY_SPF_MECHANISM);
	});

	it('prefers the costliest include when nested costs are known', () => {
		const costed = evaluateSpfCoexistence({
			publishedTxtRecords: [published([...NINE_LOOKUPS, RELAY_SPF_MECHANISM, 'include:i.example'])],
			requiredMechanisms: [OWN_SPF_MECHANISM, RELAY_SPF_MECHANISM],
			essentialMechanisms: [OWN_SPF_MECHANISM, RELAY_SPF_MECHANISM],
			includeLookupCosts: { 'b.example': 6 },
		});
		expect(costed.status).toBe('fail');
		expect(costed.flattenCandidate).toBe('include:b.example');
	});
});

describe('the alignment pre-flight surfaces the limit as a blocking SPF failure', () => {
	const result = evaluateAlignmentPreflight(
		alignedInput({
			dns: alignedDns({
				fromDomainTxt: found(published([...NINE_LOOKUPS, RELAY_SPF_MECHANISM, 'include:i.example'])),
			}),
		})
	);

	it('blocks the cell and names the include to flatten in the remedy', () => {
		expect(result.verdict).toBe('blocked');
		expect(result.allowsShareAboveZero).toBe(false);
		const spf = result.checks.find((entry) => entry.id === 'spf');
		expect(spf?.status).toBe('fail');
		expect(spf?.detail).toContain('needs 11 DNS lookups');
		expect(spf?.remedy).toContain(ALIGNMENT_REMEDIES.spf_lookup_limit);
		expect(spf?.remedy).toContain('Flatten include:i.example');
	});
});
