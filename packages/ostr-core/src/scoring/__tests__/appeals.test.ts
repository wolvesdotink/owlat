/**
 * Appeals as a weapon (plan §9.3, §10): authorship, rate limiting, and the
 * standing consequences of silence and of a substantiated response. The
 * mechanics of a single well-formed appeal live in `exclusions.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import type { ScoreResult, SequencedAttestation, SubjectRef } from '../../types.js';
import { POLICY_V1 } from '../policy.js';
import { scoreSubject } from '../score.js';
import { accusation, AS_OF, entry, trafficEntry } from './generators.js';

function score(entries: SequencedAttestation[], subject: SubjectRef): ScoreResult {
	return scoreSubject({ entries, subject, asOf: AS_OF });
}

function contribution(result: ScoreResult, signal: string): number {
	return result.explanation.find((group) => group.signal === signal)?.contribution ?? 0;
}

describe('appeals as a weapon (plan §9.3, §10)', () => {
	const VICTIM = { domain: 'victim.example' };
	const evidence = (index: number, observer: string): SequencedAttestation[] =>
		accusation({
			index,
			volumeIndex: index + 50,
			observer,
			subject: VICTIM,
			reports: 400,
			volume: 20_000,
			volumePassRate: 0.98,
			windowFromDaysAgo: 60,
			windowToDaysAgo: 40,
			loggedAtDaysAgo: 40,
		});

	const appeal = (
		index: number,
		author: string,
		subject: SubjectRef,
		contested: number[],
		daysAgo = 30
	): SequencedAttestation =>
		entry(
			'appeal',
			{
				contested: contested.map((target) => ({ logId: 'log-a', index: target })),
				statement: 'We never sent that mail.',
			},
			{ index, observer: author, subject, loggedAtDaysAgo: daysAgo }
		);

	it('ignores an appeal filed in the subject’s name by someone else', () => {
		const entries = [...evidence(2, 'accuser.example'), appeal(3, 'stranger.example', VICTIM, [2])];
		expect(contribution(score(entries, VICTIM), 'complaint-rate')).toBeLessThan(0);
	});

	it('still honours the subject’s own appeal', () => {
		const entries = [...evidence(2, 'accuser.example'), appeal(3, VICTIM.domain, VICTIM, [2])];
		expect(contribution(score(entries, VICTIM), 'complaint-rate')).toBe(0);
	});

	it('rate-limits appeals per subject inside the rolling window', () => {
		const accusers = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => `accuser-${name}.example`);
		const entries: SequencedAttestation[] = [];
		accusers.forEach((observer, i) => entries.push(...evidence(2 + i, observer)));
		accusers.forEach((_unused, i) =>
			entries.push(appeal(200 + i, VICTIM.domain, VICTIM, [2 + i], 30 - i))
		);
		const surplus = accusers.length - POLICY_V1.appeals.maxPerSubjectPerWindow;
		expect(surplus).toBeGreaterThan(0);
		// The appeals over budget are inert, so their contested batches survive.
		expect(contribution(score(entries, VICTIM), 'complaint-rate')).toBeLessThan(0);
	});

	it('does not let a re-filed appeal restart the observer’s clock', () => {
		const entries = [
			...evidence(2, 'accuser.example'),
			appeal(3, VICTIM.domain, VICTIM, [2], 30),
			appeal(4, VICTIM.domain, VICTIM, [2], 1),
		];
		// The first appeal already lapsed, so the evidence is out; the duplicate
		// neither revives it nor costs the observer a second lapse.
		expect(contribution(score(entries, VICTIM), 'complaint-rate')).toBe(0);
	});

	it('costs an observer standing once it ignores more than one appeal', () => {
		const lapsed = (subject: string, index: number): SequencedAttestation[] => [
			...accusation({
				index,
				volumeIndex: index + 50,
				observer: 'lax.example',
				subject: { domain: subject },
				reports: 400,
				volume: 20_000,
				volumePassRate: 0.98,
				windowFromDaysAgo: 60,
				windowToDaysAgo: 40,
				loggedAtDaysAgo: 40,
			}),
			appeal(index + 100, subject, { domain: subject }, [index]),
		];
		const target = { domain: 'watched.example' };
		const accusationOfTarget = accusation({
			index: 9,
			volumeIndex: 8,
			observer: 'lax.example',
			subject: target,
			reports: 400,
			volume: 20_000,
			volumePassRate: 0.98,
			windowFromDaysAgo: 60,
			windowToDaysAgo: 40,
			loggedAtDaysAgo: 40,
		});
		const responsive = score(accusationOfTarget, target);
		const negligent = score(
			[...accusationOfTarget, ...lapsed('one.example', 20), ...lapsed('two.example', 30)],
			target
		);
		expect(contribution(negligent, 'complaint-rate')).toBeGreaterThan(
			contribution(responsive, 'complaint-rate')
		);
	});

	it('charges one lapse per unanswered appeal, however many attestations it names', () => {
		// A flagged sender controls its own domain, so it can file appeals about
		// itself at will. If each contested *reference* were a lapse, one wide
		// filing inside the per-subject rate limit would strip a volunteer
		// observer of its standing everywhere — the §7.2 first-lapse grace covers
		// appeals, not references.
		const REFS = 8;
		const contested = Array.from({ length: REFS }, (_unused, i) => 2 + i);
		const evidenceAgainstFiler: SequencedAttestation[] = [];
		for (const index of contested) {
			evidenceAgainstFiler.push(
				// Distinct report counts: identical bodies would be one signed
				// record at eight coordinates, not eight attestations (spec §5.5).
				...accusation({
					index,
					volumeIndex: index + 500,
					observer: 'volunteer.example',
					subject: { domain: 'loud.example' },
					reports: 400 + index,
					volume: 20_000,
					volumePassRate: 0.98,
					windowFromDaysAgo: 60,
					windowToDaysAgo: 40,
					loggedAtDaysAgo: 40,
				})
			);
		}
		const bystander = { domain: 'bystander.example' };
		const evidenceAgainstBystander = accusation({
			index: 900,
			volumeIndex: 901,
			observer: 'volunteer.example',
			subject: bystander,
			reports: 400,
			volume: 20_000,
			volumePassRate: 0.98,
			windowFromDaysAgo: 60,
			windowToDaysAgo: 40,
			loggedAtDaysAgo: 40,
		});
		const wideAppeal = appeal(950, 'loud.example', { domain: 'loud.example' }, contested);
		const undisturbed = score([...evidenceAgainstBystander, ...evidenceAgainstFiler], bystander);
		const attacked = score(
			[...evidenceAgainstBystander, ...evidenceAgainstFiler, wideAppeal],
			bystander
		);
		expect(contribution(undisturbed, 'complaint-rate')).toBeLessThan(0);
		expect(contribution(attacked, 'complaint-rate')).toBe(
			contribution(undisturbed, 'complaint-rate')
		);
	});

	it('costs an appellant standing when the observer substantiates', () => {
		const contestedBatch = accusation({
			index: 2,
			volumeIndex: 52,
			observer: 'accuser.example',
			subject: { domain: 'crier.example' },
			reports: 400,
			volume: 20_000,
			volumePassRate: 0.98,
			windowFromDaysAgo: 60,
			windowToDaysAgo: 40,
			loggedAtDaysAgo: 40,
		});
		const criersEvidence = trafficEntry({
			index: 70,
			observer: 'crier.example',
			subject: { domain: 'observed.example' },
			messages: 2_000,
			passRate: 0.9,
			windowFromDaysAgo: 300,
			windowToDaysAgo: 2,
			loggedAtDaysAgo: 2,
		});
		const response = entry(
			'response',
			{
				appeal: { logId: 'log-a', index: 3 },
				outcome: 'substantiated',
				statement: 'Challenge sample opened.',
			},
			{
				index: 4,
				observer: 'accuser.example',
				subject: { domain: 'crier.example' },
				loggedAtDaysAgo: 20,
			}
		);
		const target = { domain: 'observed.example' };
		const quiet = score([...contestedBatch, criersEvidence], target);
		const failed = score(
			[
				...contestedBatch,
				criersEvidence,
				appeal(3, 'crier.example', { domain: 'crier.example' }, [2]),
				response,
			],
			target
		);
		expect(contribution(failed, 'auth-consistency')).toBeLessThan(
			contribution(quiet, 'auth-consistency')
		);
	});
});
