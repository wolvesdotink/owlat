/**
 * Identity: domain and IP normalization, control grouping, and the two places
 * the §6.3 bounds depend on them — the per-observer cap and the `flagged`
 * diversity rule. `scoreSubject` is a standalone public export and may not rely
 * on another module having validated its input.
 */

import { describe, expect, it } from 'vitest';
import type { ScoreResult, SequencedAttestation } from '../../types.js';
import { formatIp, parseCidr, parseIp } from '../ip.js';
import { POLICY_V1 } from '../policy.js';
import { scoreSubject } from '../score.js';
import { defaultObserverGroup, normalizeIp, registrableDomain } from '../select.js';
import { accusation, AS_OF, entry, trafficEntry, trapEntry } from './generators.js';

describe('registrable domain', () => {
	it('reduces a subdomain to the label under the public suffix', () => {
		expect(registrableDomain('mx2.selfdealer.example')).toBe('selfdealer.example');
		expect(registrableDomain('a.b.c.deep.example')).toBe('deep.example');
		expect(registrableDomain('selfdealer.example')).toBe('selfdealer.example');
		expect(registrableDomain('example')).toBe('example');
	});

	it('keeps three labels under a two-letter ccTLD second-level suffix', () => {
		expect(registrableDomain('mx.example.co.uk')).toBe('example.co.uk');
		expect(registrableDomain('example.co.uk')).toBe('example.co.uk');
		expect(registrableDomain('mx.example.com.au')).toBe('example.com.au');
		// The heuristic only fires under a two-letter ccTLD.
		expect(registrableDomain('mx.co.example')).toBe('co.example');
	});

	it('normalizes case and trailing dots before grouping', () => {
		expect(defaultObserverGroup('MX3.Accuser.Example.')).toBe('accuser.example');
		expect(defaultObserverGroup('accuser.example')).toBe('accuser.example');
	});
});

describe('IP canonicalization (plan D2)', () => {
	it('renders one address one way', () => {
		expect(normalizeIp('2001:0db8:0:0:0:0:0:1')).toBe('2001:db8::1');
		expect(normalizeIp('2001:DB8::1')).toBe('2001:db8::1');
		expect(normalizeIp(' 198.51.100.7 ')).toBe('198.51.100.7');
		expect(normalizeIp('::ffff:192.0.2.1')).toBe('::ffff:c000:201');
	});

	it('compresses the leftmost longest zero run only', () => {
		expect(formatIp(parseIp('2001:0:0:1:0:0:0:1') as never)).toBe('2001:0:0:1::1');
		expect(formatIp(parseIp('0:0:0:0:0:0:0:0') as never)).toBe('::');
	});

	it('rejects malformed literals', () => {
		for (const bad of ['', '::::', '1.2.3', '1.2.3.4.5', '256.0.0.1', '010.0.0.1', 'g::1']) {
			expect(parseIp(bad), bad).toBeUndefined();
		}
		expect(normalizeIp('not-an-ip')).toBeUndefined();
	});

	it('parses CIDR ranges and rejects over-long prefixes', () => {
		expect(parseCidr('192.0.2.0/24')?.prefix).toBe(24);
		expect(parseCidr('2001:db8::/32')?.prefix).toBe(32);
		expect(parseCidr('192.0.2.0/33')).toBeUndefined();
	});
});

describe('subject resolution by prefix (plan D2)', () => {
	const trapAt = (index: number, observer: string, ip: string): SequencedAttestation =>
		trapEntry({
			index,
			observer,
			subject: { ip },
			hits: 50,
			windowFromDaysAgo: 20,
			windowToDaysAgo: 1,
			loggedAtDaysAgo: 1,
		});

	const contribution = (result: ScoreResult, signal: string): number =>
		result.explanation.find((group) => group.signal === signal)?.contribution ?? 0;

	it('aggregates IPv6 evidence across the subject /64', () => {
		const entries = [
			trapAt(1, 'mail.observer-b.org', '2001:0db8:0:1:0:0:0:b'),
			trapAt(2, 'gw.observer-d.example', '2001:db8:0:1::c'),
		];
		const result = scoreSubject({ entries, subject: { ip: '2001:db8:0:1::a' }, asOf: AS_OF });
		expect(result.subject).toEqual({ ip: '2001:db8:0:1::a' });
		expect(contribution(result, 'trap-hits')).toBeLessThan(0);
	});

	it('keeps evidence from a different /64 out', () => {
		const entries = [trapAt(1, 'mail.observer-b.org', '2001:db8:0:2::b')];
		const result = scoreSubject({ entries, subject: { ip: '2001:db8:0:1::a' }, asOf: AS_OF });
		expect(result.explanation).toEqual([]);
	});

	it('regroups bare-IP evidence to a range the subject declared in posture', () => {
		const declaring = (range: string): SequencedAttestation[] => [
			entry(
				'posture',
				{ dmarcPolicy: 'reject', declaredIps: [range] },
				{
					index: 5,
					observer: 'multihomed.example',
					subject: { domain: 'multihomed.example' },
					loggedAtDaysAgo: 30,
				}
			),
			trapAt(6, 'mail.observer-b.org', '192.0.2.77'),
		];
		const inRange = scoreSubject({
			entries: declaring('192.0.2.0/24'),
			subject: { domain: 'multihomed.example' },
			asOf: AS_OF,
		});
		const outOfRange = scoreSubject({
			entries: declaring('203.0.113.0/24'),
			subject: { domain: 'multihomed.example' },
			asOf: AS_OF,
		});
		expect(contribution(inRange, 'trap-hits')).toBeLessThan(0);
		expect(contribution(outOfRange, 'trap-hits')).toBe(0);
	});
});

describe('observer identity in the §6.3 bounds', () => {
	const DOMAIN = 'target.example';
	const accuse = (index: number, observer: string): SequencedAttestation[] =>
		accusation({
			index,
			volumeIndex: index + 100,
			observer,
			subject: { domain: DOMAIN },
			reports: 50_000,
			volume: 100_000,
			volumePassRate: 0,
			windowFromDaysAgo: 20,
			windowToDaysAgo: 1,
			loggedAtDaysAgo: 1,
		});

	it('collapses case and trailing-dot variants into one witness', () => {
		const single = scoreSubject({
			entries: accuse(1, 'accuser.example'),
			subject: { domain: DOMAIN },
			asOf: AS_OF,
		});
		const split = scoreSubject({
			entries: [
				...accuse(1, 'accuser.example'),
				...accuse(2, 'Accuser.example'),
				...accuse(3, 'ACCUSER.EXAMPLE.'),
			],
			subject: { domain: DOMAIN },
			asOf: AS_OF,
		});
		expect(split.score).toBe(single.score);
		expect(split.tier).toBe('warned');
		expect(POLICY_V1.baseScore - split.score).toBeLessThanOrEqual(POLICY_V1.perObserverCapPoints);
	});

	it('collapses subdomains of one registrable domain for the diversity multiplier', () => {
		const summaries = (observers: readonly string[]): SequencedAttestation[] =>
			observers.map((observer, i) =>
				trafficEntry({
					index: 1 + i,
					observer,
					subject: { domain: DOMAIN },
					messages: 40_000,
					passRate: 0.99,
					windowFromDaysAgo: 300,
					windowToDaysAgo: 2,
					loggedAtDaysAgo: 2,
				})
			);
		const oneParty = scoreSubject({
			entries: summaries(['mx1.watcher.example', 'mx2.watcher.example', 'mx3.watcher.example']),
			subject: { domain: DOMAIN },
			asOf: AS_OF,
		});
		const threeParties = scoreSubject({
			entries: summaries(['a.example', 'b.example', 'c.example']),
			subject: { domain: DOMAIN },
			asOf: AS_OF,
		});
		expect(
			oneParty.explanation.find((group) => group.signal === 'observer-diversity')
		).toBeUndefined();
		expect(threeParties.score).toBeGreaterThan(oneParty.score);
	});

	it('lets a caller supply its own control grouping', () => {
		const entries = [...accuse(1, 'first.example'), ...accuse(2, 'second.example')];
		const asStrangers = scoreSubject({ entries, subject: { domain: DOMAIN }, asOf: AS_OF });
		const asOneParty = scoreSubject({
			entries,
			subject: { domain: DOMAIN },
			asOf: AS_OF,
			observerGroup: () => 'same-asn',
		});
		expect(asOneParty.score).toBeGreaterThan(asStrangers.score);
	});
});
