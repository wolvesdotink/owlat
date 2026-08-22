/**
 * The deterministic merge (spec §6.2, §5.5): cross-submitted copies are one
 * attestation, repeated coordinates are equivocation, and every rule that names
 * a `LogEntryRef` reaches the attestation whatever copy it cites.
 *
 * Cross-submission is a MUST from Phase 2, so these are not edge cases: without
 * the merge, every count, volume, trap and history signal is multiplied by the
 * number of logs a submitter reaches.
 */

import { describe, expect, it } from 'vitest';
import type { ScoreResult, SequencedAttestation, SubjectRef } from '../../types.js';
import { scoreSubject } from '../score.js';
import { accusation, AS_OF, entry, trafficEntry, trapEntry } from './generators.js';

const SUBJECT: SubjectRef = { domain: 'crossposted.example' };

function score(entries: SequencedAttestation[], subject: SubjectRef = SUBJECT): ScoreResult {
	return scoreSubject({ entries, subject, asOf: AS_OF });
}

function contribution(result: ScoreResult, signal: string): number {
	return result.explanation.find((group) => group.signal === signal)?.contribution ?? 0;
}

/** The same signed record, submitted to a second log at an unrelated index. */
function alsoOn(logId: string, index: number, source: SequencedAttestation): SequencedAttestation {
	return { ...source, logId, index, attestation: structuredClone(source.attestation) };
}

function corpus(): SequencedAttestation[] {
	return [
		trafficEntry({
			index: 1,
			observer: 'mx.observer-a.net',
			subject: SUBJECT,
			messages: 40_000,
			passRate: 0.99,
			windowFromDaysAgo: 400,
			windowToDaysAgo: 2,
			loggedAtDaysAgo: 300,
		}),
		...accusation({
			index: 2,
			volumeIndex: 3,
			observer: 'accuser.example',
			subject: SUBJECT,
			reports: 400,
			volume: 20_000,
			volumePassRate: 0.98,
			windowFromDaysAgo: 20,
			windowToDaysAgo: 1,
			loggedAtDaysAgo: 1,
		}),
	];
}

describe('cross-submission (spec §5.5)', () => {
	it('counts an attestation once however many logs hold it', () => {
		const single = score(corpus());
		const crossSubmitted = corpus();
		crossSubmitted.push(
			...corpus().map((source, i) => alsoOn('log-b', 90 + i, source)),
			...corpus().map((source, i) => alsoOn('log-c', 5 + i, source))
		);
		const merged = score(crossSubmitted);
		expect(merged.score).toBe(single.score);
		expect(merged.tier).toBe(single.tier);
		expect(merged.explanation.map((group) => [group.signal, group.contribution])).toEqual(
			single.explanation.map((group) => [group.signal, group.contribution])
		);
	});

	it('cites every coordinate the attestation reached', () => {
		const entries = corpus();
		entries.push(alsoOn('log-b', 90, entries[0] as SequencedAttestation));
		const history = score(entries).explanation.find((group) => group.signal === 'history-volume');
		expect(history?.evidence).toContainEqual({ logId: 'log-a', index: 1 });
		expect(history?.evidence).toContainEqual({ logId: 'log-b', index: 90 });
		// The union, not a repetition: the accuser's own volume summary is the
		// only other traffic in the corpus.
		expect(history?.evidence).toHaveLength(3);
	});

	it('ages negative evidence from the earliest inclusion any log proves', () => {
		const fresh = trapEntry({
			index: 7,
			observer: 'trapper.example',
			subject: SUBJECT,
			hits: 300,
			loggedAtDaysAgo: 1,
		});
		const backdated = { ...alsoOn('log-b', 7, fresh) };
		backdated.loggedAt = trapEntry({
			index: 7,
			observer: 'trapper.example',
			subject: SUBJECT,
			hits: 300,
			loggedAtDaysAgo: 400,
		}).loggedAt;
		const onlyOld = { ...fresh, loggedAt: backdated.loggedAt };
		expect(contribution(score([fresh, backdated]), 'trap-hits')).toBe(
			contribution(score([onlyOld]), 'trap-hits')
		);
		expect(contribution(score([fresh]), 'trap-hits')).toBeLessThan(
			contribution(score([fresh, backdated]), 'trap-hits')
		);
	});
});

describe('repeated coordinates (spec §5.6)', () => {
	it('keeps one leaf per (logId, index) and drops the later claim', () => {
		const honest = corpus();
		const equivocated = [
			...honest,
			trapEntry({
				index: 1,
				observer: 'trapper.example',
				subject: SUBJECT,
				hits: 5_000,
				loggedAtDaysAgo: 1,
			}),
		];
		expect(contribution(score(equivocated), 'trap-hits')).toBe(0);
		expect(score(equivocated).score).toBe(score(honest).score);
	});
});

describe('records naming a copy (spec §5.5)', () => {
	it('honours a retraction filed against the copy on another log', () => {
		const entries = corpus();
		const batch = entries[2] as SequencedAttestation;
		entries.push(
			alsoOn('log-b', 90, batch),
			entry(
				'retraction',
				{ supersedes: { logId: 'log-b', index: 90 }, reason: 'misattributed' },
				{ index: 8, observer: 'accuser.example', subject: SUBJECT, loggedAtDaysAgo: 1 }
			)
		);
		expect(contribution(score(entries), 'complaint-rate')).toBe(0);
	});

	it('honours an appeal against one copy answered against another', () => {
		const entries = corpus();
		entries.push(alsoOn('log-b', 90, entries[2] as SequencedAttestation));
		const appeal = entry(
			'appeal',
			{ contested: [{ logId: 'log-b', index: 90 }], statement: 'We never sent that mail.' },
			{ index: 9, observer: SUBJECT.domain, subject: SUBJECT, loggedAtDaysAgo: 1 }
		);
		const response = entry(
			'response',
			{
				appeal: { logId: 'log-c', index: 4 },
				outcome: 'retracted',
				statement: 'Sample opened; the mail was not theirs.',
			},
			{ index: 10, observer: 'accuser.example', subject: SUBJECT, loggedAtDaysAgo: 1 }
		);
		// The response cites the appeal's copy on a third log, and the appeal is
		// inside its response window, so only the retraction can exclude here.
		expect(
			contribution(
				score([...entries, appeal, alsoOn('log-c', 4, appeal), response]),
				'complaint-rate'
			)
		).toBe(0);
		expect(contribution(score([...entries, appeal]), 'complaint-rate')).toBeLessThan(0);
	});
});
