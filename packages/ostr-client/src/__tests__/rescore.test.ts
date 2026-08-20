/**
 * Consumer sovereignty, end to end (plan §3, spec 08 §8.4): a receiver that
 * does not believe an observer drops it and recomputes, and the number moves.
 *
 * The fixture is small on purpose — one sender, three observers, one of whom
 * files the complaints — so the assertions read as the claim itself: excluding
 * the complainant removes the complaint-rate signal, raises the score and
 * lifts the tier, and excluding nobody reproduces the aggregator's arithmetic
 * exactly.
 */

import { scoreSubject, type SequencedAttestation, type SubjectRef } from '@owlat/ostr-core';
import { describe, expect, it } from 'vitest';
import {
	filterExcludedObservers,
	isObserverExcluded,
	rescoreWithLocalPolicy,
	type ConsumerPolicy,
} from '../rescore.js';

const AS_OF = '2026-08-20T00:00:00Z';
const DAY_MS = 86_400_000;
const SUBJECT: SubjectRef = { domain: 'example.com' };

function daysAgo(days: number): string {
	return new Date(Date.parse(AS_OF) - days * DAY_MS).toISOString().replace('.000Z', 'Z');
}

function logEntry(
	kind: SequencedAttestation['attestation']['kind'],
	observer: string,
	body: unknown,
	index: number
): SequencedAttestation {
	return {
		logId: 'log-a',
		index,
		loggedAt: daysAgo(1),
		attestation: {
			v: 1,
			kind,
			observer,
			subject: SUBJECT,
			window: { from: daysAgo(30), to: daysAgo(2) },
			body,
			sig: 'ed25519:c2lnbmF0dXJlLXBsYWNlaG9sZGVy',
		},
	};
}

/** A month of perfectly authenticated mail, as one observer saw it. */
function traffic(messages: number): Record<string, number> {
	return {
		messages,
		spfPass: messages,
		dkimPass: messages,
		dmarcPass: messages,
		tlsInbound: messages,
		uniqueRecipientsBucket: 4,
		bounceRateBucket: 0,
	};
}

const ENTRIES: SequencedAttestation[] = [
	logEntry('traffic-summary', 'good.example', traffic(100_000), 1),
	logEntry('traffic-summary', 'other.example', traffic(100_000), 2),
	logEntry('traffic-summary', 'grumpy.example', traffic(100_000), 3),
	logEntry(
		'spam-report-batch',
		'grumpy.example',
		{ reports: 5_000, commitment: 'a'.repeat(64) },
		4
	),
	logEntry('traffic-summary', 'mx2.grumpy.example', traffic(10_000), 5),
];

function signals(explanation: { signal: string }[]): string[] {
	return explanation.map((group) => group.signal);
}

describe('rescoreWithLocalPolicy', () => {
	it('reproduces the aggregator`s score when nothing is excluded', () => {
		const published = scoreSubject({ entries: ENTRIES, subject: SUBJECT, asOf: AS_OF });
		const local = rescoreWithLocalPolicy({ entries: ENTRIES, subject: SUBJECT, asOf: AS_OF });
		expect(local.score).toBe(published.score);
		expect(local.tier).toBe(published.tier);
		expect(local.explanation).toEqual(published.explanation);
	});

	it('raises the score and the tier when the complaining observer is excluded', () => {
		const published = scoreSubject({ entries: ENTRIES, subject: SUBJECT, asOf: AS_OF });
		const local = rescoreWithLocalPolicy({
			entries: ENTRIES,
			subject: SUBJECT,
			asOf: AS_OF,
			excludeObservers: ['grumpy.example'],
		});

		expect(signals(published.explanation)).toContain('complaint-rate');
		expect(signals(local.explanation)).not.toContain('complaint-rate');
		expect(local.score).toBeGreaterThan(published.score);
		expect(published.tier).toBe('unknown');
		expect(local.tier).toBe('establishing');
	});

	it('marks the result as local and names the exclusions that produced it', () => {
		const local = rescoreWithLocalPolicy({
			entries: ENTRIES,
			subject: SUBJECT,
			asOf: AS_OF,
			excludeObservers: ['grumpy.example'],
		});
		expect(local.local).toBe(true);
		expect(local.excludedObservers).toEqual(['grumpy.example']);
		expect(local.subject).toEqual(SUBJECT);
	});

	it('leaves the believed observers` evidence entirely intact', () => {
		const local = rescoreWithLocalPolicy({
			entries: ENTRIES,
			subject: SUBJECT,
			asOf: AS_OF,
			excludeObservers: ['grumpy.example'],
		});
		const cited = local.explanation.flatMap((group) => group.evidence.map((ref) => ref.index));
		expect(cited).toContain(1);
		expect(cited).toContain(2);
		expect(cited).not.toContain(3);
		expect(cited).not.toContain(4);
		expect(cited).not.toContain(5);
	});

	it('does not let an unrelated exclusion change the answer', () => {
		const published = scoreSubject({ entries: ENTRIES, subject: SUBJECT, asOf: AS_OF });
		const local = rescoreWithLocalPolicy({
			entries: ENTRIES,
			subject: SUBJECT,
			asOf: AS_OF,
			excludeObservers: ['nobody.example'],
		});
		expect(local.score).toBe(published.score);
	});

	it('passes an observer grouping through to the policy', () => {
		const result = rescoreWithLocalPolicy({
			entries: ENTRIES,
			subject: SUBJECT,
			asOf: AS_OF,
			observerGroup: () => 'one-party',
		});
		// Every witness collapsing into one party costs the subject its
		// diversity credit, which is exactly what the grouper is for.
		expect(signals(result.explanation)).not.toContain('observer-diversity');
	});
});

describe('observer exclusion matching', () => {
	it('covers the named domain and its subdomains', () => {
		expect(isObserverExcluded('grumpy.example', ['grumpy.example'])).toBe(true);
		expect(isObserverExcluded('mx2.grumpy.example', ['grumpy.example'])).toBe(true);
		expect(isObserverExcluded('MX2.Grumpy.Example.', ['grumpy.example'])).toBe(true);
	});

	it('does not cover a sibling or a lookalike name', () => {
		expect(isObserverExcluded('good.example', ['grumpy.example'])).toBe(false);
		expect(isObserverExcluded('notgrumpy.example', ['grumpy.example'])).toBe(false);
		expect(isObserverExcluded('grumpy.example.evil.test', ['grumpy.example'])).toBe(false);
	});

	it('does not widen an exclusion of a subdomain to its parent`s siblings', () => {
		expect(isObserverExcluded('mx.example.com', ['mail.example.com'])).toBe(false);
		expect(isObserverExcluded('example.com', ['mail.example.com'])).toBe(false);
	});

	it.each([[''], ['   '], ['.']])('ignores the meaningless exclusion %p', (exclusion) => {
		expect(isObserverExcluded('grumpy.example', [exclusion])).toBe(false);
	});

	it('drops every attestation the excluded party authored, subdomains included', () => {
		const kept = filterExcludedObservers(ENTRIES, ['grumpy.example']);
		expect(kept.map((held) => held.index)).toEqual([1, 2]);
	});

	it('returns a copy, never the caller`s array, when nothing is excluded', () => {
		const kept = filterExcludedObservers(ENTRIES, []);
		expect(kept).toEqual(ENTRIES);
		expect(kept).not.toBe(ENTRIES);
	});

	it('takes the persisted policy shape directly, without hand-spread fields', () => {
		const policy: ConsumerPolicy = { excludeObservers: ['grumpy.example'] };
		const local = rescoreWithLocalPolicy({
			entries: ENTRIES,
			subject: SUBJECT,
			asOf: AS_OF,
			policy,
		});
		expect(local.excludedObservers).toEqual(['grumpy.example']);
		expect(signals(local.explanation)).not.toContain('complaint-rate');
	});

	it('applies the policy`s exclusions on top of the ones named directly', () => {
		const local = rescoreWithLocalPolicy({
			entries: ENTRIES,
			subject: SUBJECT,
			asOf: AS_OF,
			excludeObservers: ['other.example'],
			policy: { excludeObservers: ['grumpy.example'] },
		});
		expect(local.excludedObservers).toEqual(['other.example', 'grumpy.example']);
		expect(filterExcludedObservers(ENTRIES, local.excludedObservers).map((e) => e.index)).toEqual([
			1,
		]);
	});

	it('normalizes and de-duplicates the exclusions it reports', () => {
		// Two consumers spelling one exclusion differently must not emit two
		// different provenances for the same policy.
		const local = rescoreWithLocalPolicy({
			entries: ENTRIES,
			subject: SUBJECT,
			asOf: AS_OF,
			excludeObservers: ['Grumpy.Example.', 'grumpy.example', '   ', 'not a domain'],
		});
		expect(local.excludedObservers).toEqual(['grumpy.example']);
	});

	it('THROWS on observer weights rather than quietly returning the unweighted score', () => {
		// §8.4's second half is not implemented; a receiver running its
		// published weights must not silently get the number without them.
		expect(() =>
			rescoreWithLocalPolicy({
				entries: ENTRIES,
				subject: SUBJECT,
				asOf: AS_OF,
				policy: { observerWeights: { 'grumpy.example': 0.5 } },
			})
		).toThrow(/observerWeights is not honoured/);
	});

	it('accepts an empty weight map, which asks for nothing', () => {
		const local = rescoreWithLocalPolicy({
			entries: ENTRIES,
			subject: SUBJECT,
			asOf: AS_OF,
			policy: { observerWeights: {} },
		});
		expect(local.local).toBe(true);
	});
});
