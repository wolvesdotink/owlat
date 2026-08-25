/**
 * Subject universe discovery (D2/D3): which identities the aggregator scores,
 * and how it decides two entries are talking about the same one.
 */

import { describe, expect, it } from 'vitest';
import { scoreSubject } from '@owlat/ostr-core/scoring';
import type { SequencedAttestation, SubjectRef } from '@owlat/ostr-core';
import { canonicalSubject, discoverSubjects, isScorableSubject, subjectKey } from '../subjects.js';

function entry(index: number, subject: SubjectRef): SequencedAttestation {
	return {
		logId: 'https://log.test/ostr',
		index,
		loggedAt: '2026-08-19T00:00:00Z',
		attestation: {
			v: 1,
			kind: 'trap-hit',
			observer: 'mx.observer-a.net',
			subject,
			window: { from: '2026-08-01T00:00:00Z', to: '2026-08-18T00:00:00Z' },
			body: { hits: 1 },
			sig: 'ed25519:c2lnbmF0dXJlLXBsYWNlaG9sZGVy',
		},
	};
}

describe('canonicalSubject', () => {
	it('takes the policy normalization: lowercase domains, canonical IP literals', () => {
		expect(canonicalSubject({ domain: 'Example.TEST.' })).toEqual({ domain: 'example.test' });
		expect(canonicalSubject({ ip: '2001:0db8:0000::0001' })).toEqual({ ip: '2001:db8::1' });
		expect(canonicalSubject({ ip: 'not-an-address' })).toEqual({});
	});

	it('gives one key to every spelling of one identity', () => {
		expect(subjectKey({ domain: 'EXAMPLE.test' })).toBe(subjectKey({ domain: 'example.test.' }));
		expect(subjectKey({ ip: '2001:db8:0:0:0:0:0:1' })).toBe(subjectKey({ ip: '2001:DB8::1' }));
		expect(subjectKey({ domain: 'a.test' })).not.toBe(subjectKey({ domain: 'b.test' }));
	});

	it('agrees with the identity the policy reports when it actually scores', () => {
		// The normalization is obtained by scoring against an empty entry set,
		// so this pins the assumption that makes that legitimate: `ScoreResult`
		// carries the normalized subject, whatever the entry set.
		const entries = [entry(0, { domain: 'Tenant.Test' })];
		const scored = scoreSubject({
			entries,
			subject: { domain: 'Tenant.Test.' },
			asOf: '2026-08-19T00:00:00Z',
		});

		expect(canonicalSubject({ domain: 'Tenant.Test.' })).toEqual(scored.subject);
	});

	it('knows a subject that names nothing', () => {
		expect(isScorableSubject({})).toBe(false);
		expect(isScorableSubject(canonicalSubject({ ip: '10.0.0.256' }))).toBe(false);
		expect(isScorableSubject({ ip: '10.0.0.1' })).toBe(true);
	});
});

describe('discoverSubjects', () => {
	it('expands (ip, domain) evidence to the domain alone: the pair is not an identity', () => {
		const found = discoverSubjects([entry(0, { domain: 'tenant.test', ip: '203.0.113.9' })]);

		// A pair subject scores byte-identically to its bare domain under
		// policy-v1 — D2 separability lives in evidence selection, not in a
		// second scored identity — so materializing it would publish an alias.
		expect(found.map((subject) => subject.subject)).toEqual([{ domain: 'tenant.test' }]);
		expect(found[0]?.entryIndexes).toEqual([0]);
	});

	it('does not invent a bare-IP subject out of evidence that named a domain', () => {
		const found = discoverSubjects([
			entry(0, { domain: 'tenant.test', ip: '203.0.113.9' }),
			entry(1, { ip: '203.0.113.9' }),
		]);

		expect(found.map((subject) => subject.subject)).toEqual([
			{ domain: 'tenant.test' },
			{ ip: '203.0.113.9' },
		]);
		expect(found[1]?.entryIndexes).toEqual([1]);
	});

	it('discovers a bare IP only from evidence that presented no domain', () => {
		const found = discoverSubjects([entry(0, { ip: '203.0.113.9' })]);

		expect(found.map((subject) => subject.subject)).toEqual([{ ip: '203.0.113.9' }]);
	});

	it('collapses spellings and keeps every naming entry', () => {
		const found = discoverSubjects([
			entry(0, { domain: 'Tenant.Test' }),
			entry(1, { domain: 'tenant.test.' }),
			entry(2, { domain: 'other.test' }),
		]);

		expect(found).toHaveLength(2);
		expect(found[0]?.subject).toEqual({ domain: 'other.test' });
		expect(found[1]?.entryIndexes).toEqual([0, 1]);
	});

	it('skips entries whose subject names nothing scorable', () => {
		expect(discoverSubjects([entry(0, {}), entry(1, { ip: '999.1.1.1' })])).toEqual([]);
	});

	it('is order-independent: the universe is a function of the entry set', () => {
		const entries = [
			entry(0, { domain: 'b.test' }),
			entry(1, { ip: '198.51.100.7' }),
			entry(2, { domain: 'a.test', ip: '198.51.100.9' }),
		];

		expect(discoverSubjects(entries)).toEqual(discoverSubjects([...entries].reverse()));
	});
});
