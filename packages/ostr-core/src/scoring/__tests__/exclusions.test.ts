/**
 * Exclusion rules: appeals (plan §9.3), retractions, vouch revocation and
 * `asOf` visibility. Each case asserts on the presence of the signal group the
 * contested evidence feeds, so an exclusion that silently changes weight
 * instead of removing evidence still fails.
 */

import { describe, expect, it } from 'vitest';
import type { ScoreResult, SequencedAttestation } from '../../types.js';
import { POLICY_V1 } from '../policy.js';
import { scoreSubject } from '../score.js';
import { accusation, AS_OF, daysBefore, entry, trafficEntry } from './generators.js';

const SUBJECT = { domain: 'appellant.example' };
const ACCUSER = 'accuser.example';

function hasSignal(result: ScoreResult, signal: string): boolean {
	return result.explanation.some((group) => group.signal === signal);
}

/**
 * One clean summary plus one accusation. The accuser attests its own volume for
 * the contested window because plan §7.3 makes that a precondition of the
 * report batch counting at all; the batch under appeal is `log-a#2`.
 */
function baseEntries(): SequencedAttestation[] {
	return [
		trafficEntry({
			index: 1,
			observer: 'mx.observer-a.net',
			subject: SUBJECT,
			messages: 20_000,
			passRate: 0.98,
			windowFromDaysAgo: 200,
			windowToDaysAgo: 2,
			loggedAtDaysAgo: 2,
		}),
		...accusation({
			index: 2,
			volumeIndex: 20,
			observer: ACCUSER,
			subject: SUBJECT,
			reports: 400,
			volume: 20_000,
			windowFromDaysAgo: 60,
			windowToDaysAgo: 40,
			loggedAtDaysAgo: 40,
		}),
	];
}

interface AppealCase {
	appealDaysAgo: number;
	appellant?: string;
	responder?: string;
	responseDaysAgo?: number;
	outcome?: 'substantiated' | 'retracted';
}

function withAppeal(options: AppealCase): SequencedAttestation[] {
	const entries = baseEntries();
	entries.push(
		entry(
			'appeal',
			{ contested: [{ logId: 'log-a', index: 2 }], statement: 'We never sent that mail.' },
			{
				index: 3,
				observer: options.appellant ?? SUBJECT.domain,
				subject: { domain: options.appellant ?? SUBJECT.domain },
				loggedAtDaysAgo: options.appealDaysAgo,
			}
		)
	);
	if (options.responseDaysAgo !== undefined) {
		entries.push(
			entry(
				'response',
				{
					appeal: { logId: 'log-a', index: 3 },
					outcome: options.outcome ?? 'substantiated',
					statement: 'Challenge sample opened.',
				},
				{
					index: 4,
					observer: options.responder ?? ACCUSER,
					subject: SUBJECT,
					loggedAtDaysAgo: options.responseDaysAgo,
				}
			)
		);
	}
	return entries;
}

function score(entries: SequencedAttestation[]): ScoreResult {
	return scoreSubject({ entries, subject: SUBJECT, asOf: AS_OF });
}

/** The contested report batch inside a {@link baseEntries} corpus. */
function reportBatch(entries: SequencedAttestation[]): SequencedAttestation {
	const batch = entries.find((candidate) => candidate.attestation.kind === 'spam-report-batch');
	if (batch === undefined) throw new Error('fixture has no report batch');
	return batch;
}

describe('appeals (plan §9.3)', () => {
	it('excludes contested evidence when the response window elapses unanswered', () => {
		expect(hasSignal(score(baseEntries()), 'complaint-rate')).toBe(true);
		const result = score(withAppeal({ appealDaysAgo: 30 }));
		expect(hasSignal(result, 'complaint-rate')).toBe(false);
	});

	it('leaves the evidence in place while the response window is still open', () => {
		const stillOpen = POLICY_V1.appeals.responseWindowDays - 1;
		const result = score(withAppeal({ appealDaysAgo: stillOpen }));
		expect(hasSignal(result, 'complaint-rate')).toBe(true);
	});

	it('keeps evidence the named observer substantiated inside the window', () => {
		const result = score(withAppeal({ appealDaysAgo: 30, responseDaysAgo: 20 }));
		expect(hasSignal(result, 'complaint-rate')).toBe(true);
	});

	it('excludes evidence the named observer retracted in its response', () => {
		const result = score(
			withAppeal({ appealDaysAgo: 30, responseDaysAgo: 20, outcome: 'retracted' })
		);
		expect(hasSignal(result, 'complaint-rate')).toBe(false);
	});

	it('ignores a substantiation filed after the response window closed', () => {
		const result = score(withAppeal({ appealDaysAgo: 30, responseDaysAgo: 1 }));
		expect(hasSignal(result, 'complaint-rate')).toBe(false);
	});

	it('ignores a response from an observer other than the accused', () => {
		const result = score(
			withAppeal({ appealDaysAgo: 30, responseDaysAgo: 20, responder: 'bystander.example' })
		);
		expect(hasSignal(result, 'complaint-rate')).toBe(false);
	});

	it('ignores an appeal filed outside the evidence retention window', () => {
		const entries = baseEntries();
		const stale = reportBatch(entries);
		stale.loggedAt = daysBefore(POLICY_V1.appeals.filingWindowDays + 40);
		entries.push(
			entry(
				'appeal',
				{ contested: [{ logId: 'log-a', index: 2 }], statement: 'Too late.' },
				{ index: 3, observer: SUBJECT.domain, subject: SUBJECT, loggedAtDaysAgo: 30 }
			)
		);
		expect(hasSignal(score(entries), 'complaint-rate')).toBe(true);
	});

	it('ignores an appeal filed by a party that is not the subject', () => {
		const result = score(withAppeal({ appealDaysAgo: 30, appellant: 'meddler.example' }));
		expect(hasSignal(result, 'complaint-rate')).toBe(true);
	});
});

describe('retractions', () => {
	it('supersedes the attestation when filed by its own observer', () => {
		const entries = baseEntries();
		entries.push(
			entry(
				'retraction',
				{ supersedes: { logId: 'log-a', index: 2 }, reason: 'misattributed' },
				{ index: 5, observer: ACCUSER, subject: SUBJECT, loggedAtDaysAgo: 5 }
			)
		);
		expect(hasSignal(score(entries), 'complaint-rate')).toBe(false);
	});

	it('is ignored when filed by anyone else', () => {
		const entries = baseEntries();
		entries.push(
			entry(
				'retraction',
				{ supersedes: { logId: 'log-a', index: 2 }, reason: 'not mine to retract' },
				{ index: 5, observer: 'stranger.example', subject: SUBJECT, loggedAtDaysAgo: 5 }
			)
		);
		expect(hasSignal(score(entries), 'complaint-rate')).toBe(true);
	});
});

describe('vouches', () => {
	const vouch = (index: number, observer: string, expiresDaysAgo: number): SequencedAttestation =>
		entry(
			'vouch',
			{ scope: 'transactional mail only', expires: daysBefore(expiresDaysAgo) },
			{ index, observer, subject: SUBJECT, loggedAtDaysAgo: 30 }
		);

	it('counts an unexpired vouch', () => {
		const result = score([vouch(10, 'sponsor.example', -30)]);
		expect(hasSignal(result, 'vouches')).toBe(true);
		expect(result.score).toBeGreaterThan(POLICY_V1.baseScore);
	});

	it('ignores an expired vouch', () => {
		const result = score([vouch(10, 'sponsor.example', 1)]);
		expect(hasSignal(result, 'vouches')).toBe(false);
		expect(result.score).toBe(POLICY_V1.baseScore);
	});

	it('excludes a vouch its voucher revoked, and only its voucher', () => {
		const revoke = (observer: string): SequencedAttestation =>
			entry(
				'vouch-revoke',
				{ vouch: { logId: 'log-a', index: 10 }, reason: 'tenant left' },
				{ index: 11, observer, subject: SUBJECT, loggedAtDaysAgo: 10 }
			);
		expect(
			hasSignal(score([vouch(10, 'sponsor.example', -30), revoke('sponsor.example')]), 'vouches')
		).toBe(false);
		expect(
			hasSignal(score([vouch(10, 'sponsor.example', -30), revoke('rival.example')]), 'vouches')
		).toBe(true);
	});

	it('caps the total vouch contribution however many vouchers pile in', () => {
		const entries = Array.from({ length: 20 }, (_unused, i) =>
			vouch(20 + i, `sponsor-${i}.example`, -30)
		);
		const result = score(entries);
		const group = result.explanation.find((candidate) => candidate.signal === 'vouches');
		expect(group?.contribution).toBeLessThanOrEqual(POLICY_V1.vouch.capPoints);
		expect(group?.evidence).toHaveLength(20);
	});
});

describe('asOf visibility', () => {
	it('ignores entries logged after the evaluation time', () => {
		const entries = baseEntries();
		const future = reportBatch(entries);
		future.loggedAt = daysBefore(-1);
		expect(hasSignal(score(entries), 'complaint-rate')).toBe(false);
	});

	it('ignores entries whose window has not closed at the evaluation time', () => {
		const entries = baseEntries();
		const future = reportBatch(entries);
		// Logged long ago, but claiming a period that runs into the future.
		future.attestation.window = { from: daysBefore(60), to: daysBefore(-1) };
		expect(hasSignal(score(entries), 'complaint-rate')).toBe(false);
	});

	it('scores a window that closes exactly at the evaluation instant', () => {
		// `[from, to)` is half-open, so a window ending at `asOf` has closed.
		const entries = baseEntries();
		reportBatch(entries).attestation.window = { from: daysBefore(60), to: AS_OF };
		expect(hasSignal(score(entries), 'complaint-rate')).toBe(true);
	});
});
