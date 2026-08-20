/**
 * Signal behavior: decay, the bounded signals' caps, subject resolution (plan
 * D2/D3) and the shape of the explanation. Observer standing has its own file,
 * as do the adversarial cases.
 */

import { describe, expect, it } from 'vitest';
import type { LogEntryRef, ScoreResult, SequencedAttestation, SubjectRef } from '../../types.js';
import { extractFacts } from '../facts.js';
import { POLICY_V1 } from '../policy.js';
import { scoreSubject } from '../score.js';
import { accusation, AS_OF, daysBefore, entry, trafficEntry, trapEntry } from './generators.js';

function score(entries: SequencedAttestation[], subject: SubjectRef): ScoreResult {
	return scoreSubject({ entries, subject, asOf: AS_OF });
}

function contribution(result: ScoreResult, signal: string): number {
	return result.explanation.find((group) => group.signal === signal)?.contribution ?? 0;
}

const DOMAIN = 'subject.example';

function traffic(index: number, messages: number, passRate: number): SequencedAttestation {
	return trafficEntry({
		index,
		observer: 'mx.observer-a.net',
		subject: { domain: DOMAIN },
		messages,
		passRate,
		windowFromDaysAgo: 300,
		windowToDaysAgo: 2,
		loggedAtDaysAgo: 2,
	});
}

describe('time decay of negative evidence', () => {
	const withAge = (ageDays: number): ScoreResult =>
		score(
			[
				traffic(1, 20_000, 0.99),
				...accusation({
					index: 2,
					observer: 'accuser.example',
					subject: { domain: DOMAIN },
					reports: 60,
					volume: 20_000,
					windowFromDaysAgo: ageDays + 10,
					windowToDaysAgo: ageDays,
					loggedAtDaysAgo: ageDays,
				}),
			],
			{ domain: DOMAIN }
		);

	it('weighs an aged complaint batch less than a fresh one of the same size', () => {
		const fresh = contribution(withAge(1), 'complaint-rate');
		const oneHalfLife = contribution(withAge(POLICY_V1.negativeHalfLifeDays), 'complaint-rate');
		const ancient = contribution(withAge(POLICY_V1.negativeHalfLifeDays * 8), 'complaint-rate');
		expect(fresh).toBeLessThan(0);
		expect(oneHalfLife).toBeGreaterThan(fresh);
		expect(ancient).toBeGreaterThan(oneHalfLife);
		expect(Math.abs(ancient)).toBeLessThan(1);
	});

	it('ages evidence whose window ends in the future from loggedAt, not from the window', () => {
		// `orderEntries` drops a not-yet-closed window (spec §2.4), so this
		// entry is handed to `extractFacts` directly: the fallback in
		// `evidenceTime` is the second lock, and it has to hold on its own.
		const trap = trapEntry({
			index: 1,
			observer: 'trap-operator.example',
			subject: { domain: DOMAIN },
			hits: 100,
			loggedAtDaysAgo: POLICY_V1.negativeHalfLifeDays * 2,
		});
		trap.attestation.window = { from: daysBefore(400), to: daysBefore(-3_650) };
		const facts = extractFacts(
			[{ ...trap, refs: [{ logId: trap.logId, index: trap.index }] }],
			DOMAIN,
			AS_OF
		);
		// Two half-lives at 100 hits is 25; an undecayed reading would be 100.
		expect(facts.traps.total).toBeCloseTo(25, 6);
	});

	it('does not decay positive history', () => {
		// Four low-volume observers so the per-observer cap does not bind and the
		// two runs differ in nothing but the age of the evidence.
		const summaries = (fromDaysAgo: number, toDaysAgo: number): SequencedAttestation[] =>
			[0, 1, 2, 3].map((i) =>
				trafficEntry({
					index: 1 + i,
					logId: i % 2 === 0 ? 'log-a' : 'log-b',
					observer: `observer-${i}.example`,
					subject: { domain: DOMAIN },
					messages: 2_000,
					passRate: 0.99,
					windowFromDaysAgo: fromDaysAgo,
					windowToDaysAgo: toDaysAgo,
					loggedAtDaysAgo: toDaysAgo,
				})
			);
		const recent = score(summaries(300, 2), { domain: DOMAIN });
		const older = score(summaries(800, 400), { domain: DOMAIN });
		expect(contribution(older, 'auth-consistency')).toBe(contribution(recent, 'auth-consistency'));
	});
});

describe('window instants', () => {
	it('orders mixed-offset windows chronologically, not lexicographically', () => {
		// Both summaries are logged well before either candidate window start, so
		// the log anchor (see `resolveHistory`) leaves the claimed instants in
		// charge — the regime this test is about. The message counts differ so
		// that two summaries with equal windows stay two attestations rather than
		// one cross-submitted copy of the same signed record.
		const summary = (index: number, from: string, to: string): SequencedAttestation => {
			const built = trafficEntry({
				index,
				observer: 'mx.observer-a.net',
				subject: { domain: DOMAIN },
				messages: 10_000 + index,
				passRate: 0.99,
				windowFromDaysAgo: 100,
				windowToDaysAgo: 2,
				loggedAtDaysAgo: 30,
			});
			built.attestation.window = { from, to };
			return built;
		};
		const TO = '2026-08-19T00:00:00Z';
		const history = (first: string, second: string): number =>
			contribution(
				score([summary(1, first, TO), summary(2, second, TO)], { domain: DOMAIN }),
				'history-volume'
			);
		// `2026-08-15T00:00:00+14:00` is `2026-08-14T10:00:00Z`: the earlier
		// instant, but the later string.
		const mixedOffsets = history('2026-08-15T00:00:00+14:00', '2026-08-14T20:00:00Z');
		const sameInstants = history('2026-08-14T10:00:00Z', '2026-08-14T20:00:00Z');
		const whatStringOrderWouldPick = history('2026-08-14T20:00:00Z', '2026-08-14T20:00:00Z');
		expect(mixedOffsets).toBe(sameInstants);
		expect(mixedOffsets).not.toBe(whatStringOrderWouldPick);
	});
});

describe('authentication gate', () => {
	it('lets an unauthenticated sender accrue no positive history', () => {
		const result = score([traffic(1, 500_000, 0)], { domain: DOMAIN });
		expect(contribution(result, 'auth-consistency')).toBe(0);
		expect(contribution(result, 'history-volume')).toBe(0);
		expect(result.score).toBe(POLICY_V1.baseScore);
	});
});

describe('bounded signals', () => {
	it('caps posture and never lets it exceed establishing', () => {
		const result = score(
			[
				entry(
					'posture',
					{
						dmarcPolicy: 'reject',
						dmarcAlignment: 'strict',
						dnssec: true,
						mtaSts: true,
						tlsRpt: true,
						declaredIps: ['198.51.100.1'],
						registeredBefore: daysBefore(4_000),
					},
					{ index: 1, observer: DOMAIN, subject: { domain: DOMAIN }, loggedAtDaysAgo: 1 }
				),
			],
			{ domain: DOMAIN }
		);
		expect(contribution(result, 'posture')).toBe(POLICY_V1.posture.maxLiftPoints);
		expect(result.tier).toBe('establishing');
	});

	it('caps trap evidence that only one observer has seen', () => {
		const single = score(
			[
				trapEntry({
					index: 1,
					observer: 'trapper.example',
					subject: { domain: DOMAIN },
					hits: 100_000,
					windowFromDaysAgo: 10,
					windowToDaysAgo: 1,
					loggedAtDaysAgo: 1,
				}),
			],
			{ domain: DOMAIN }
		);
		expect(contribution(single, 'trap-hits')).toBe(-POLICY_V1.trap.singleObserverCapPoints);

		const shared = score(
			[0, 1, 2].map((i) =>
				trapEntry({
					index: 10 + i,
					observer: `trapper-${i}.example`,
					subject: { domain: DOMAIN },
					hits: 100_000,
					windowFromDaysAgo: 10,
					windowToDaysAgo: 1,
					loggedAtDaysAgo: 1,
				})
			),
			{ domain: DOMAIN }
		);
		expect(contribution(shared, 'trap-hits')).toBeLessThan(-POLICY_V1.trap.singleObserverCapPoints);
	});

	it('multiplies observed positive evidence by observer diversity', () => {
		const summaries = (count: number): SequencedAttestation[] =>
			Array.from({ length: count }, (_unused, i) =>
				trafficEntry({
					index: 1 + i,
					observer: `observer-${i}.example`,
					subject: { domain: DOMAIN },
					messages: 40_000,
					passRate: 0.99,
					windowFromDaysAgo: 300,
					windowToDaysAgo: 2,
					loggedAtDaysAgo: 2,
				})
			);
		const alone = score(summaries(1), { domain: DOMAIN });
		const corroborated = score(summaries(4), { domain: DOMAIN });
		expect(contribution(alone, 'observer-diversity')).toBe(0);
		expect(contribution(corroborated, 'observer-diversity')).toBeGreaterThan(0);
		expect(corroborated.score).toBeGreaterThan(alone.score);
	});
});

describe('subject resolution (plan D2/D3)', () => {
	const pairEvidence = trafficEntry({
		index: 1,
		observer: 'mx.observer-a.net',
		subject: { domain: DOMAIN, ip: '198.51.100.7' },
		messages: 30_000,
		passRate: 0.99,
		windowFromDaysAgo: 300,
		windowToDaysAgo: 2,
		loggedAtDaysAgo: 2,
	});
	const bareIpTraps = trapEntry({
		index: 2,
		observer: 'mail.observer-b.org',
		subject: { ip: '198.51.100.7' },
		hits: 40,
		windowFromDaysAgo: 20,
		windowToDaysAgo: 1,
		loggedAtDaysAgo: 1,
	});
	const posture = (declaredIps: string[]): SequencedAttestation =>
		entry(
			'posture',
			{ dmarcPolicy: 'reject', declaredIps },
			{ index: 3, observer: DOMAIN, subject: { domain: DOMAIN }, loggedAtDaysAgo: 30 }
		);

	it('flows (ip, domain) pair evidence into the domain', () => {
		const result = score([pairEvidence], { domain: DOMAIN });
		expect(contribution(result, 'auth-consistency')).toBeGreaterThan(0);
	});

	it('flows bare-IP evidence into the domain only for declared IPs', () => {
		const declared = score([pairEvidence, bareIpTraps, posture(['198.51.100.7'])], {
			domain: DOMAIN,
		});
		const undeclared = score([pairEvidence, bareIpTraps, posture(['203.0.113.5'])], {
			domain: DOMAIN,
		});
		expect(contribution(declared, 'trap-hits')).toBeLessThan(0);
		expect(contribution(undeclared, 'trap-hits')).toBe(0);
	});

	it('keeps a bare-IP subject clear of another tenant’s pair evidence', () => {
		const result = score([pairEvidence, bareIpTraps], { ip: '198.51.100.7' });
		expect(contribution(result, 'trap-hits')).toBeLessThan(0);
		expect(contribution(result, 'auth-consistency')).toBe(0);
		expect(result.subject).toEqual({ ip: '198.51.100.7' });
	});

	it('gives an ESP customer subdomain standing separate from the ESP', () => {
		const customer = trafficEntry({
			index: 4,
			observer: 'mx.observer-a.net',
			subject: { domain: 'customer.esp.example' },
			messages: 90_000,
			passRate: 0.99,
			windowFromDaysAgo: 300,
			windowToDaysAgo: 2,
			loggedAtDaysAgo: 2,
		});
		expect(score([customer], { domain: 'esp.example' }).explanation).toEqual([]);
		expect(score([customer], { domain: 'customer.esp.example' }).score).toBeGreaterThan(
			POLICY_V1.baseScore
		);
	});

	it('normalizes case and trailing dots in the queried subject', () => {
		const result = score([pairEvidence], { domain: 'SUBJECT.Example.' });
		expect(result.subject).toEqual({ domain: DOMAIN });
		expect(contribution(result, 'auth-consistency')).toBeGreaterThan(0);
	});
});

describe('explanation shape', () => {
	// Indices straddle 10 inside one log so the evidence-order assertion below
	// distinguishes numeric from lexicographic ordering.
	const mixed = (): SequencedAttestation[] => [
		traffic(2, 60_000, 0.97),
		trafficEntry({
			index: 10,
			observer: 'mail.observer-b.org',
			subject: { domain: DOMAIN },
			messages: 20_000,
			passRate: 0.96,
			windowFromDaysAgo: 200,
			windowToDaysAgo: 2,
			loggedAtDaysAgo: 2,
		}),
		...accusation({
			index: 3,
			volumeIndex: 11,
			logId: 'log-b',
			observer: 'accuser.example',
			subject: { domain: DOMAIN },
			reports: 120,
			volume: 30_000,
			passRate: 0.95,
			windowFromDaysAgo: 20,
			windowToDaysAgo: 1,
			loggedAtDaysAgo: 1,
		}),
	];

	it('sorts groups by contribution magnitude, then signal name', () => {
		const groups = score(mixed(), { domain: DOMAIN }).explanation;
		for (let i = 1; i < groups.length; i++) {
			const previous = groups[i - 1] as { signal: string; contribution: number };
			const current = groups[i] as { signal: string; contribution: number };
			const left = Math.abs(previous.contribution);
			const right = Math.abs(current.contribution);
			expect(left).toBeGreaterThanOrEqual(right);
			if (left === right) expect(previous.signal < current.signal).toBe(true);
		}
	});

	it('adds up: the score is the base plus the published contributions', () => {
		const result = score(mixed(), { domain: DOMAIN });
		const total = result.explanation.reduce(
			(sum, group) => sum + group.contribution,
			POLICY_V1.baseScore
		);
		expect(result.score).toBe(Math.round(total));
	});

	it('lists evidence in log order and stamps the policy version', () => {
		const result = score(mixed(), { domain: DOMAIN });
		expect(result.policy).toBe(POLICY_V1.version);
		// Log order is (logId, then *numeric* index) — the same comparator the
		// engine sorts with. A lexicographic check would pass on single-digit
		// fixtures and lie about everything else.
		const inLogOrder = (refs: readonly LogEntryRef[]): LogEntryRef[] =>
			[...refs].sort((a, b) =>
				a.logId === b.logId ? a.index - b.index : a.logId < b.logId ? -1 : 1
			);
		let straddlesTen = false;
		for (const group of result.explanation) {
			expect(group.evidence).toEqual(inLogOrder(group.evidence));
			const indices = group.evidence.map((ref) => ref.index);
			if (indices.some((index) => index < 10) && indices.some((index) => index >= 10)) {
				straddlesTen = true;
			}
		}
		expect(straddlesTen).toBe(true);
	});
});
