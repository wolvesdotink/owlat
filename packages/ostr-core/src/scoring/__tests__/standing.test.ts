/**
 * Observer standing (plan §6.3): the weight an attestation carries is its
 * author's own score, discounted for upheld audit-findings against it. The
 * depth bound is asserted here too — it is what stops a Sybil ring from
 * bootstrapping itself.
 */

import { describe, expect, it } from 'vitest';
import type { ScoreResult, SequencedAttestation, SubjectRef } from '../../types.js';
import { POLICY_V1 } from '../policy.js';
import { scoreSubject } from '../score.js';
import { accusation, AS_OF, entry, trafficEntry, trapEntry } from './generators.js';

const DOMAIN = 'subject.example';

function score(entries: SequencedAttestation[], subject: SubjectRef): ScoreResult {
	return scoreSubject({ entries, subject, asOf: AS_OF });
}

function contribution(result: ScoreResult, signal: string): number {
	return result.explanation.find((group) => group.signal === signal)?.contribution ?? 0;
}

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

describe('observer standing (plan §6.3)', () => {
	const hostile = (): SequencedAttestation[] => [
		traffic(1, 40_000, 0.99),
		...accusation({
			index: 2,
			observer: 'accuser.example',
			subject: { domain: DOMAIN },
			reports: 80,
			volume: 40_000,
			windowFromDaysAgo: 10,
			windowToDaysAgo: 1,
			loggedAtDaysAgo: 1,
		}),
	];

	const auditFinding = (
		index: number,
		subject: string,
		observer: string,
		options: { daysAgo?: number; finding?: string } = {}
	): SequencedAttestation =>
		entry(
			'audit-finding',
			{
				finding: options.finding ?? 'statistical-outlier',
				evidence: [{ logId: 'log-a', index: 2 }],
				statement: 'Report volume exceeds observed inbound volume.',
			},
			{
				index,
				observer,
				subject: { domain: subject },
				loggedAtDaysAgo: options.daysAgo ?? POLICY_V1.observerStanding.upheldAfterDays + 5,
			}
		);

	it('discounts an observer under an upheld audit-finding', () => {
		const plain = contribution(score(hostile(), { domain: DOMAIN }), 'complaint-rate');
		const audited = contribution(
			score([...hostile(), auditFinding(50, 'accuser.example', 'monitor.example')], {
				domain: DOMAIN,
			}),
			'complaint-rate'
		);
		expect(audited).toBeGreaterThan(plain);
		// Exact up to the 2-decimal rounding of published contributions.
		expect(audited / plain).toBeCloseTo(POLICY_V1.observerStanding.auditFindingPenalty, 2);
	});

	it('does not count a finding the accused has not yet had time to contest', () => {
		const plain = contribution(score(hostile(), { domain: DOMAIN }), 'complaint-rate');
		const fresh = contribution(
			score(
				[...hostile(), auditFinding(50, 'accuser.example', 'monitor.example', { daysAgo: 1 })],
				{
					domain: DOMAIN,
				}
			),
			'complaint-rate'
		);
		expect(fresh).toBe(plain);
	});

	it('counts repeat findings from one author as one finding', () => {
		const once = contribution(
			score([...hostile(), auditFinding(50, 'accuser.example', 'grudge.example')], {
				domain: DOMAIN,
			}),
			'complaint-rate'
		);
		const sixTimes = contribution(
			score(
				[
					...hostile(),
					...[0, 1, 2, 3, 4, 5].map((i) =>
						auditFinding(50 + i, 'accuser.example', 'grudge.example')
					),
				],
				{ domain: DOMAIN }
			),
			'complaint-rate'
		);
		expect(sixTimes).toBe(once);
	});

	it('counts findings from distinct authors separately', () => {
		const two = contribution(
			score(
				[
					...hostile(),
					auditFinding(50, 'accuser.example', 'monitor.example'),
					auditFinding(51, 'accuser.example', 'other-monitor.example'),
				],
				{ domain: DOMAIN }
			),
			'complaint-rate'
		);
		const one = contribution(
			score([...hostile(), auditFinding(50, 'accuser.example', 'monitor.example')], {
				domain: DOMAIN,
			}),
			'complaint-rate'
		);
		expect(two).toBeGreaterThan(one);
	});

	it('weighs an observer with its own clean history above a fresh one', () => {
		const standingEvidence = (): SequencedAttestation[] => [
			trafficEntry({
				index: 60,
				logId: 'log-b',
				observer: 'peer.example',
				subject: { domain: 'accuser.example' },
				messages: 800_000,
				passRate: 1,
				windowFromDaysAgo: 900,
				windowToDaysAgo: 2,
				loggedAtDaysAgo: 2,
			}),
			trafficEntry({
				index: 61,
				logId: 'log-b',
				observer: 'peer-two.example',
				subject: { domain: 'accuser.example' },
				messages: 700_000,
				passRate: 1,
				windowFromDaysAgo: 900,
				windowToDaysAgo: 2,
				loggedAtDaysAgo: 2,
			}),
		];
		const plain = contribution(score(hostile(), { domain: DOMAIN }), 'complaint-rate');
		const standing = contribution(
			score([...hostile(), ...standingEvidence()], { domain: DOMAIN }),
			'complaint-rate'
		);
		expect(standing).toBeLessThan(plain);
	});

	/**
	 * Depth bound: standing is computed one level deep. Evidence about the
	 * accuser changes the result; evidence about the party that wrote *that*
	 * evidence does not, because depth 1 weighs every witness at base weight.
	 */
	it('stops the standing recursion at depth 1', () => {
		const aboutAccuser = trapEntry({
			index: 70,
			logId: 'log-b',
			observer: 'peer.example',
			subject: { domain: 'accuser.example' },
			hits: 400,
			windowFromDaysAgo: 20,
			windowToDaysAgo: 1,
			loggedAtDaysAgo: 1,
		});
		const depthOne = [...hostile(), aboutAccuser];
		const depthTwo = [...depthOne, auditFinding(71, 'peer.example', 'monitor.example')];
		expect(contribution(score(depthOne, { domain: DOMAIN }), 'complaint-rate')).toBeGreaterThan(
			contribution(score(hostile(), { domain: DOMAIN }), 'complaint-rate')
		);
		expect(score(depthTwo, { domain: DOMAIN })).toEqual(score(depthOne, { domain: DOMAIN }));
	});
});
