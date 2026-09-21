/**
 * Property tests for `ostr-policy-v1`: the invariants the policy promises,
 * checked over a seeded corpus rather than a handful of examples.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalize } from '../../jcs.js';
import type { SequencedAttestation, SubjectRef } from '../../types.js';
import { POLICY_V1 } from '../policy.js';
import { scoreSubject } from '../score.js';
import {
	accusation,
	AS_OF,
	cleanSubject,
	entry,
	lcg,
	shuffle,
	trafficEntry,
	trapEntry,
} from './generators.js';

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'goldens');

interface Scenario {
	subject: SubjectRef;
	asOf: string;
	entries: SequencedAttestation[];
}

const goldenScenarios: { name: string; scenario: Scenario }[] = readdirSync(GOLDEN_DIR)
	.filter((file) => file.endsWith('.input.json'))
	.sort()
	.map((file) => ({
		name: file.slice(0, -'.input.json'.length),
		scenario: JSON.parse(readFileSync(join(GOLDEN_DIR, file), 'utf8')) as Scenario,
	}));

describe('permutation invariance', () => {
	for (const { name, scenario } of goldenScenarios) {
		it(`${name} scores identically under 16 permutations of its input`, () => {
			const expected = canonicalize(
				scoreSubject({
					entries: scenario.entries,
					subject: scenario.subject,
					asOf: scenario.asOf,
				})
			);
			for (let seed = 1; seed <= 16; seed++) {
				const permuted = shuffle(scenario.entries, lcg(seed));
				const actual = canonicalize(
					scoreSubject({ entries: permuted, subject: scenario.subject, asOf: scenario.asOf })
				);
				expect(actual, `seed ${seed}`).toBe(expected);
			}
		});
	}

	it('is unaffected by duplicated log coordinates', () => {
		const { entries, subject } = cleanSubject(lcg(7), 'dupe.example');
		const base = canonicalize(scoreSubject({ entries, subject, asOf: AS_OF }));
		const doubled = canonicalize(
			scoreSubject({ entries: [...entries, ...entries], subject, asOf: AS_OF })
		);
		expect(doubled).toBe(base);
	});
});

describe('score range', () => {
	it('is always an integer in [0, 100]', () => {
		const random = lcg(99);
		for (let i = 0; i < 200; i++) {
			const domain = `subject-${i}.example`;
			const { entries, subject } = cleanSubject(random, domain);
			// Mix in negative evidence of wildly varying magnitude.
			const negativeObservers = Math.floor(random() * 5);
			for (let o = 0; o < negativeObservers; o++) {
				entries.push(
					...accusation({
						index: 500 + o,
						volumeIndex: 700 + o,
						logId: 'log-c',
						observer: `reporter-${o}.example`,
						subject: { domain },
						reports: Math.floor(random() * 50_000),
						volume: 1 + Math.floor(random() * 5_000_000),
						volumePassRate: random(),
						windowFromDaysAgo: 30,
						windowToDaysAgo: Math.floor(random() * 400),
						loggedAtDaysAgo: 1,
					}),
					trapEntry({
						index: 600 + o,
						logId: 'log-c',
						observer: `reporter-${o}.example`,
						subject: { domain },
						hits: Math.floor(random() * 5_000),
						windowFromDaysAgo: 30,
						windowToDaysAgo: 2,
						loggedAtDaysAgo: 1,
					})
				);
			}
			const result = scoreSubject({ entries, subject, asOf: AS_OF });
			expect(Number.isInteger(result.score), `${domain} score ${result.score}`).toBe(true);
			expect(result.score).toBeGreaterThanOrEqual(POLICY_V1.minScore);
			expect(result.score).toBeLessThanOrEqual(POLICY_V1.maxScore);
			expect(result.policy).toBe(POLICY_V1.version);
		}
	});

	it('reports contributions rounded to the policy precision', () => {
		for (const { scenario } of goldenScenarios) {
			const result = scoreSubject({
				entries: scenario.entries,
				subject: scenario.subject,
				asOf: scenario.asOf,
			});
			for (const group of result.explanation) {
				const scaled = group.contribution * 100;
				expect(Math.abs(scaled - Math.round(scaled))).toBeLessThan(1e-9);
			}
		}
	});
});

describe('monotonicity', () => {
	it('never lowers a clean subject when clean positive evidence is added', () => {
		const random = lcg(4242);
		for (let i = 0; i < 100; i++) {
			const domain = `mono-${i}.example`;
			const { entries, subject } = cleanSubject(random, domain);
			const before = scoreSubject({ entries, subject, asOf: AS_OF }).score;
			const added = [
				...entries,
				trafficEntry({
					index: 900 + i,
					logId: 'log-z',
					observer: `fresh-observer-${i}.example`,
					subject: { domain },
					messages: 1_000 + Math.floor(random() * 100_000),
					passRate: 1,
					windowFromDaysAgo: 200,
					windowToDaysAgo: 1,
					loggedAtDaysAgo: 1,
				}),
			];
			const after = scoreSubject({ entries: added, subject, asOf: AS_OF }).score;
			expect(after, `${domain}: ${before} -> ${after}`).toBeGreaterThanOrEqual(before);
		}
	});
});

describe('flagged tier diversity rule', () => {
	it('is unreachable with fewer than three distinct negative observers', () => {
		const random = lcg(31337);
		for (let i = 0; i < 120; i++) {
			const domain = `hostile-${i}.example`;
			const observers = 1 + Math.floor(random() * 2);
			const entries: SequencedAttestation[] = [];
			for (let o = 0; o < observers; o++) {
				entries.push(
					...accusation({
						index: 10 + o,
						volumeIndex: 40 + o,
						observer: `accuser-${o}.example`,
						subject: { domain },
						reports: 10_000 + Math.floor(random() * 1_000_000),
						volume: 100_000,
						volumePassRate: 0,
						windowFromDaysAgo: 20,
						windowToDaysAgo: 1,
						loggedAtDaysAgo: 1,
					}),
					trapEntry({
						index: 20 + o,
						observer: `accuser-${o}.example`,
						subject: { domain },
						hits: 1_000 + Math.floor(random() * 100_000),
						windowFromDaysAgo: 20,
						windowToDaysAgo: 1,
						loggedAtDaysAgo: 1,
					})
				);
			}
			const result = scoreSubject({ entries, subject: { domain }, asOf: AS_OF });
			expect(result.tier, `${domain} with ${observers} accusers`).not.toBe('flagged');
			expect(result.tier).toBe('warned');
		}
	});

	it('is reachable once three parties under disjoint control report', () => {
		const domain = 'ring.example';
		const entries: SequencedAttestation[] = [];
		for (let o = 0; o < POLICY_V1.flaggedMinDistinctObservers; o++) {
			entries.push(
				...accusation({
					index: 10 + o,
					volumeIndex: 40 + o,
					observer: `accuser-${o}.example`,
					subject: { domain },
					reports: 50_000,
					volume: 100_000,
					volumePassRate: 0,
					windowFromDaysAgo: 20,
					windowToDaysAgo: 1,
					loggedAtDaysAgo: 1,
				})
			);
		}
		expect(scoreSubject({ entries, subject: { domain }, asOf: AS_OF }).tier).toBe('flagged');
	});

	it('is unreachable when the three accusers are one party wearing three names', () => {
		const domain = 'ring.example';
		const entries: SequencedAttestation[] = [];
		const names = ['accuser.example', 'Accuser.example', 'mx3.accuser.example.'];
		for (const [o, observer] of names.entries()) {
			entries.push(
				...accusation({
					index: 10 + o,
					volumeIndex: 40 + o,
					observer,
					subject: { domain },
					reports: 50_000,
					volume: 100_000,
					volumePassRate: 0,
					windowFromDaysAgo: 20,
					windowToDaysAgo: 1,
					loggedAtDaysAgo: 1,
				})
			);
		}
		const result = scoreSubject({ entries, subject: { domain }, asOf: AS_OF });
		expect(result.tier).toBe('warned');
		expect(POLICY_V1.baseScore - result.score).toBeLessThanOrEqual(POLICY_V1.perObserverCapPoints);
	});
});

describe('self-dealing (plan §6.1, §7.3)', () => {
	it('never lets self-authored evidence alone exceed establishing', () => {
		const random = lcg(8_675_309);
		for (let i = 0; i < 60; i++) {
			const domain = `selfdealer-${i}.example`;
			const entries: SequencedAttestation[] = [
				entry(
					'posture',
					{ dmarcPolicy: 'reject', dmarcAlignment: 'strict', dnssec: true, mtaSts: true },
					{ index: 1, observer: domain, subject: { domain }, loggedAtDaysAgo: 900 }
				),
			];
			// A wildcard DNS record's worth of "observers", all the subject itself.
			for (let o = 0; o < 2 + Math.floor(random() * 6); o++) {
				entries.push(
					trafficEntry({
						index: 100 + o,
						observer: `mx${o}.${domain}`,
						subject: { domain },
						messages: 1_000_000 + Math.floor(random() * 5_000_000),
						passRate: 1,
						windowFromDaysAgo: 1_500,
						windowToDaysAgo: 1,
						loggedAtDaysAgo: 1,
					})
				);
			}
			const result = scoreSubject({ entries, subject: { domain }, asOf: AS_OF });
			expect(result.tier, `${domain} reached ${result.tier} at ${result.score}`).not.toBe(
				'trusted'
			);
			expect(result.score).toBeLessThan(POLICY_V1.tiers.establishingBelow);
		}
	});
});

describe('per-observer cap', () => {
	it('bounds any single observer to the policy cap in either direction', () => {
		const random = lcg(555);
		for (let i = 0; i < 50; i++) {
			const domain = `capped-${i}.example`;
			const entries = [
				...accusation({
					index: 1,
					volumeIndex: 3,
					observer: 'lone.example',
					subject: { domain },
					reports: 1_000 + Math.floor(random() * 1_000_000),
					volume: 200_000,
					volumePassRate: 0,
					windowFromDaysAgo: 10,
					windowToDaysAgo: 1,
					loggedAtDaysAgo: 1,
				}),
				trapEntry({
					index: 2,
					observer: 'lone.example',
					subject: { domain },
					hits: 100 + Math.floor(random() * 100_000),
					windowFromDaysAgo: 10,
					windowToDaysAgo: 1,
					loggedAtDaysAgo: 1,
				}),
			];
			const result = scoreSubject({ entries, subject: { domain }, asOf: AS_OF });
			const moved = POLICY_V1.baseScore - result.score;
			expect(moved).toBeLessThanOrEqual(POLICY_V1.perObserverCapPoints);
		}
	});
});
