/**
 * P4-7 — THE D11 GUARD.
 *
 * "NEVER GIVE THE TWO ARMS OF A CELL DIFFERENT SENDING IDENTITIES. Same From
 * domain, same d=, same Message-ID scheme, same tracking […]; only Received
 * headers and the DKIM SELECTOR differ. Per-STREAM subdomains are correct and
 * are P4-7's job; PER-TRANSPORT subdomains split domain reputation, make the
 * arms incomparable, and throw away the reputation the relay arm spent weeks
 * building."
 *
 * The guard is deliberately written over the GENERATED RECORDS rather than over
 * two derivations of the same expression. Re-deriving both arms from a layout
 * can never disagree — `arm` reaches nothing but the selector — so an assertion
 * on that is a guaranteed pass and proves nothing. What CAN diverge is (a) a
 * row that puts an arm on a host of its own and (b) a selector we SIGN with
 * that we never PUBLISHED, which is a silent, total DKIM failure for the whole
 * subdomain. Both are asserted here, and both can fail.
 */

import { describe, expect, it } from 'vitest';
import { GOVERNED_MESSAGE_TYPES } from '@owlat/shared';
import {
	dkimSelectorLabel,
	findPerTransportSubdomainViolations,
	findUnpublishedSigningSelectors,
	generateStreamSubdomainRecords,
	type StreamSubdomainRecordInput,
	type StreamSubdomainRecordSet,
} from '../streamSubdomainRecords';
import {
	DEFAULT_ARM_SELECTOR_SUFFIXES,
	planStreamSubdomains,
	resolveCellSendingIdentity,
	type SubdomainLayoutProposal,
} from '../streamSubdomains';

function layoutOf(domain: string, base: string): SubdomainLayoutProposal {
	const result = planStreamSubdomains({ domain, dkimSelectorBase: base });
	if (!result.ok) throw new Error(`expected a layout for ${domain}`);
	return result.proposal;
}

function recordSetOf(input: StreamSubdomainRecordInput): StreamSubdomainRecordSet {
	const result = generateStreamSubdomainRecords(input);
	if (!result.ok) throw new Error(`expected records for ${input.domain}`);
	return result.recordSet;
}

const LAYOUT = layoutOf('example.com', 's1711');

const BOTH_ARMS: StreamSubdomainRecordInput = {
	domain: 'example.com',
	sendingIps: ['203.0.113.10'],
	dmarcPolicy: 'none',
	mailHost: 'mta.example.com',
	dkimSelectorBase: 's1711',
	referenceArmConfigured: true,
};

describe('both arms of a cell share one sending identity', () => {
	it.each(GOVERNED_MESSAGE_TYPES)('stream %s: the arms agree field by field', (stream) => {
		const own = resolveCellSendingIdentity({ layout: LAYOUT, stream, arm: 'own' });
		const reference = resolveCellSendingIdentity({ layout: LAYOUT, stream, arm: 'reference' });
		expect(own.fromDomain).toBe(reference.fromDomain);
		expect(own.dkimDomain).toBe(reference.dkimDomain);
		expect(own.returnPathDomain).toBe(reference.returnPathDomain);
	});

	it('d= is ALWAYS the From domain — alignment is not optional', () => {
		for (const stream of GOVERNED_MESSAGE_TYPES) {
			for (const arm of ['own', 'reference'] as const) {
				const identity = resolveCellSendingIdentity({ layout: LAYOUT, stream, arm });
				expect(identity.dkimDomain).toBe(identity.fromDomain);
			}
		}
	});

	it('the ONE permitted difference is the DKIM selector', () => {
		const own = resolveCellSendingIdentity({ layout: LAYOUT, stream: 'campaign', arm: 'own' });
		const reference = resolveCellSendingIdentity({
			layout: LAYOUT,
			stream: 'campaign',
			arm: 'reference',
		});
		expect(own.dkimSelector).not.toBe(reference.dkimSelector);
	});

	it('a custom per-arm selector suffix still cannot move the domain', () => {
		const suffixes = { own: 'mta', reference: 'esp' };
		const own = resolveCellSendingIdentity({
			layout: LAYOUT,
			stream: 'campaign',
			arm: 'own',
			armSelectorSuffix: suffixes,
		});
		const reference = resolveCellSendingIdentity({
			layout: LAYOUT,
			stream: 'campaign',
			arm: 'reference',
			armSelectorSuffix: suffixes,
		});
		expect(own.dkimSelector).toBe('s1711-news-mta');
		expect(reference.dkimSelector).toBe('s1711-news-esp');
		expect(own.fromDomain).toBe(reference.fromDomain);
		expect(own.dkimDomain).toBe(reference.dkimDomain);
	});

	it('the STREAM is what moves the domain — per-stream is the correct axis', () => {
		const campaign = resolveCellSendingIdentity({ layout: LAYOUT, stream: 'campaign', arm: 'own' });
		const transactional = resolveCellSendingIdentity({
			layout: LAYOUT,
			stream: 'transactional',
			arm: 'own',
		});
		expect(campaign.fromDomain).toBe('news.example.com');
		expect(transactional.fromDomain).toBe('mail.example.com');
	});
});

describe('THE GUARD: what we sign with is what we published', () => {
	it('every arm signs with a selector the table actually publishes', () => {
		expect(findUnpublishedSigningSelectors(recordSetOf(BOTH_ARMS))).toEqual([]);
	});

	it('holds for custom per-arm suffixes too', () => {
		const recordSet = recordSetOf({
			...BOTH_ARMS,
			armSelectorSuffixes: { own: 'mta', reference: 'esp' },
		});
		expect(findUnpublishedSigningSelectors(recordSet)).toEqual([]);
	});

	it('holds standalone, where only the own arm has a published row', () => {
		const recordSet = recordSetOf({ ...BOTH_ARMS, referenceArmConfigured: false });
		expect(findUnpublishedSigningSelectors(recordSet)).toEqual([]);
	});

	it('the signing selector is EXACTLY the published label for that stream and arm', () => {
		const recordSet = recordSetOf(BOTH_ARMS);
		for (const stream of GOVERNED_MESSAGE_TYPES) {
			for (const arm of ['own', 'reference'] as const) {
				const identity = resolveCellSendingIdentity({ layout: recordSet.layout, stream, arm });
				const row = recordSet.records.find(
					(entry) =>
						entry.purpose === 'dkim' && entry.arm === arm && entry.subdomain === identity.dkimDomain
				);
				expect(row).toBeDefined();
				expect(row && dkimSelectorLabel(row.host, row.subdomain)).toBe(identity.dkimSelector);
			}
		}
	});

	it('CAN FAIL: a published selector that drifts from the signed one is reported', () => {
		// Exactly the shape of the bug this guard exists for — the arm-suffix
		// default growing a second, divergent copy. Mail would then be signed with
		// a selector that has no TXT record and DKIM would fail silently for every
		// message on the subdomain.
		const recordSet = recordSetOf(BOTH_ARMS);
		const drifted: StreamSubdomainRecordSet = {
			...recordSet,
			records: recordSet.records.map((record) =>
				record.purpose === 'dkim' && record.arm === 'own'
					? { ...record, host: record.host.replace('-a._domainkey', '-z._domainkey') }
					: record
			),
		};
		const mismatches = findUnpublishedSigningSelectors(drifted);
		expect(mismatches.length).toBeGreaterThan(0);
		expect(mismatches.every((entry) => entry.arm === 'own')).toBe(true);
		expect(mismatches[0]?.signsWith).toContain(`-${DEFAULT_ARM_SELECTOR_SUFFIXES.own}`);
	});
});

describe('the generated records cannot express a per-transport subdomain', () => {
	const recordSet = recordSetOf({
		...BOTH_ARMS,
		armSelectorSuffixes: { own: 'mta', reference: 'esp' },
	});
	const records = recordSet.records;

	it('no arm gets a sending host of its own', () => {
		expect(findPerTransportSubdomainViolations(recordSet)).toEqual([]);
	});

	it('CAN FAIL: a row on an arm-specific host is reported', () => {
		const violating: StreamSubdomainRecordSet = {
			...recordSet,
			records: records.map((record) =>
				record.purpose === 'dkim' && record.arm === 'own'
					? { ...record, subdomain: 'mta.example.com', host: 'x._domainkey.mta.example.com' }
					: record
			),
		};
		const violations = findPerTransportSubdomainViolations(violating);
		expect(violations.length).toBeGreaterThan(0);
		expect(violations[0]?.subdomain).toBe('mta.example.com');
	});

	it('every host lives under one of the three proposed subdomains', () => {
		const allowed = ['mail.example.com', 'news.example.com', 'bounces.example.com'];
		for (const record of records) {
			expect(allowed).toContain(record.subdomain);
			expect(record.host.endsWith(record.subdomain)).toBe(true);
		}
	});

	it('the two arms sign under the SAME subdomain with different selectors', () => {
		const byArm = new Map<string, string>();
		for (const row of records) {
			if (row.purpose !== 'dkim' || row.subdomain !== 'news.example.com') continue;
			byArm.set(row.arm, row.host);
		}
		expect(byArm.size).toBe(2);
		expect(byArm.get('own')).toBe('s1711-news-mta._domainkey.news.example.com');
		expect(byArm.get('reference')).toBe('s1711-news-esp._domainkey.news.example.com');
	});

	it('no record host contains a transport name as a SUBDOMAIN label', () => {
		// A selector may name the transport (`…-mta._domainkey.…`); a SUBDOMAIN
		// may not (`mta.example.com`, `relay.example.com`, `esp.example.com`).
		for (const record of records) {
			const labels = record.subdomain.split('.');
			expect(labels[0]).not.toBe('mta');
			expect(labels[0]).not.toBe('relay');
			expect(labels[0]).not.toBe('esp');
		}
	});

	it('one SPF record per host authorises BOTH arms, never one per arm', () => {
		const spfHosts = records.filter((r) => r.purpose === 'spf').map((r) => r.host);
		expect(new Set(spfHosts).size).toBe(spfHosts.length);
	});

	it('the reference arm is absent by default — standalone is the default', () => {
		const standalone = recordSetOf({
			domain: 'example.com',
			sendingIps: ['203.0.113.10'],
			dmarcPolicy: 'none',
		}).records.filter((r) => r.purpose === 'dkim');
		expect(standalone).toHaveLength(2); // one per SENDING SUBDOMAIN, own arm only
		expect(standalone.every((r) => r.purpose === 'dkim' && r.arm === 'own')).toBe(true);
	});
});
