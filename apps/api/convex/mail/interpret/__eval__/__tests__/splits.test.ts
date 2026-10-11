/**
 * Split integrity and decision-label consistency over the checked-in corpus,
 * plus proof that each check fires on a corpus that breaks it.
 */
import { describe, expect, it } from 'vitest';
import { parseEvalCorpus, type EvalThread } from '../corpus';
import { CLAIM_PHRASES, EVAL_SPLITS, unbackedClaims } from '../decisionLabels';
import { splitIntegrityProblems, threadsInSplit } from '../splits';
import { loadCorpus } from './corpusFixture';

const corpus = loadCorpus();

describe('corpus splits', () => {
	it('puts every thread in exactly one split, each a fair share of the corpus', () => {
		const sizes = EVAL_SPLITS.map((split) => threadsInSplit(corpus, split).length);
		expect(sizes.reduce((a, b) => a + b, 0)).toBe(corpus.length);
		for (const size of sizes) expect(size / corpus.length).toBeGreaterThan(0.25);
		expect(threadsInSplit(corpus, 'all')).toHaveLength(corpus.length);
	});

	it('has no integrity problem: every split covers each language, surface and class', () => {
		expect(splitIntegrityProblems(corpus)).toEqual([]);
	});

	it('labels every thread with at least one decision about an inbound message', () => {
		for (const thread of corpus) {
			expect(thread.labels.decisions.length, thread.id).toBeGreaterThan(0);
		}
		const decisions = corpus.flatMap((t) => t.labels.decisions);
		expect(decisions.filter((d) => d.disposition === 'reply').length).toBeGreaterThanOrEqual(30);
		expect(decisions.flatMap((d) => d.drafts ?? []).length).toBeGreaterThanOrEqual(20);
		expect(corpus.filter((t) => t.mode === 'actions').length).toBeGreaterThanOrEqual(20);
	});

	it('accepts no draft that brings a number the thread does not hold', () => {
		// Invented amounts, dates and times are the commonest unsupported claim a
		// draft makes; an accepted draft may only repeat what the thread says.
		const numbers = (text: string) => text.match(/\d+(?:[.,:]\d+)*/g) ?? [];
		for (const thread of corpus) {
			const said = new Set(
				thread.messages.flatMap((m) => numbers(`${m.subject} ${m.text ?? m.html ?? ''}`))
			);
			for (const d of thread.labels.decisions) {
				for (const draft of d.drafts ?? []) {
					if (draft.acceptance !== 'accept') continue;
					for (const n of numbers(draft.text))
						expect(said, `${thread.id}/${draft.id}: ${n}`).toContain(n);
				}
			}
		}
	});

	it('reports a split that lacks a language, a class or a fair share', () => {
		const english = corpus.map((t) =>
			t.split === 'heldout' ? { ...t, locale: 'en' as const } : t
		);
		expect(splitIntegrityProblems(english)).toContain('heldout: no locale de');

		const noSpam = corpus.filter(
			(t) => !(t.split === 'train' && t.labels.decisions.some((d) => d.triage === 'spam'))
		);
		expect(splitIntegrityProblems(noSpam)).toContain('train: no triage spam');

		const lopsided = corpus.map((t) =>
			t.split === 'calibration' ? { ...t, split: 'train' as const } : t
		);
		expect(splitIntegrityProblems(lopsided).some((p) => p.startsWith('calibration: 0 of'))).toBe(
			true
		);
	});

	it('reports the same message text in two splits', () => {
		const heldout = threadsInSplit(corpus, 'heldout')[0] as EvalThread;
		const train = threadsInSplit(corpus, 'train')[0] as EvalThread;
		const copy = { ...train, messages: [...heldout.messages] };
		const leaked = corpus.map((t) => (t.id === train.id ? copy : t));
		expect(
			splitIntegrityProblems(leaked).some((p) => p.includes('repeats a heldout message'))
		).toBe(true);
	});
});

describe('decision label checks', () => {
	const base = corpus.find((t) => t.id === 'en-001') as EvalThread;
	const file = (thread: unknown) => ({ version: 1, slice: 'en', threads: [thread] });
	const withDecision = (patch: Record<string, unknown>) => ({
		...base,
		labels: { ...base.labels, decisions: [{ ...base.labels.decisions[0], ...patch }] },
	});

	it('accepts the labelled thread as is', () => {
		expect(() => parseEvalCorpus([file(base)])).not.toThrow();
	});

	it('refuses labels that contradict their thread or each other', () => {
		expect(() => parseEvalCorpus([file(withDecision({ messageId: 'nope' }))])).toThrow(
			/unknown message/
		);
		expect(() => parseEvalCorpus([file(withDecision({ postboxCategory: undefined }))])).toThrow(
			/postbox category/
		);
		expect(() => parseEvalCorpus([file(withDecision({ triage: 'spam' }))])).toThrow(/spam/);
		expect(() => parseEvalCorpus([file(withDecision({ triage: 'no_work' }))])).toThrow(
			/only needs_work/
		);
		expect(() => parseEvalCorpus([file(withDecision({ clarification: undefined }))])).toThrow(
			/clarification/
		);
		expect(() =>
			parseEvalCorpus([
				file(withDecision({ disposition: 'informational', clarification: undefined })),
			])
		).toThrow(/drafts/);
		const twice = {
			...base,
			labels: { ...base.labels, decisions: [base.labels.decisions[0], base.labels.decisions[0]] },
		};
		expect(() => parseEvalCorpus([file(twice)])).toThrow(/two decisions/);
		const outbound = corpus.find((t) => t.id === 'en-002') as EvalThread;
		const onOutbound = {
			...outbound,
			labels: {
				...outbound.labels,
				decisions: [{ ...outbound.labels.decisions[0], messageId: 'm2' }],
			},
		};
		expect(() => parseEvalCorpus([file(onOutbound)])).toThrow(/not inbound/);
		const { split: _split, ...unsplit } = base;
		expect(() => parseEvalCorpus([file(unsplit)])).toThrow();
	});
});

describe('unsupported claims in drafts', () => {
	const team003 = corpus.find((t) => t.id === 'team-003') as EvalThread;
	const de001 = corpus.find((t) => t.id === 'de-001') as EvalThread;
	const threadText = (t: EvalThread) =>
		t.messages.map((m) => `${m.subject}\n${m.text ?? ''}`).join('\n');
	// The two drafts Sol's review caught, as they were labelled before.
	const OLD_TEAM_003 =
		"Hi Tomás,\n\nwe've noted your cancellation. Your subscription ends on the last day of this month.\n\nAcme Support";
	const OLD_DE_001 =
		'Hallo Lena,\n\ndanke dir! Das überarbeitete Angebot bekommst du bis Mittwoch, und Donnerstag um 14 Uhr passt mir gut.\n\nViele Grüße\nMara';

	it('finds outcome claims and confirmations the thread does not back', () => {
		expect(unbackedClaims(OLD_TEAM_003, threadText(team003))).toEqual(["we've noted", 'ends on']);
		expect(unbackedClaims(OLD_DE_001, threadText(de001))).toEqual(['passt mir']);
		expect(unbackedClaims('Your refund has been issued.', 'Please refund me.')).toEqual([
			'has been',
			'issued',
		]);
		expect(unbackedClaims('Ich habe den Betrag überwiesen.', 'Bitte zahlen.')).toEqual([
			'überwiesen',
		]);
		expect(unbackedClaims("Thanks, I'll look into it and get back to you.", '')).toEqual([]);
	});

	it('accepts a claim the thread itself makes, and matches whole words only', () => {
		expect(
			unbackedClaims('Great that it has been shipped.', 'Your order has been shipped.')
		).toEqual([]);
		expect(unbackedClaims('The file looks unprocessed and unsigned.', '')).toEqual([]);
		for (const phrase of CLAIM_PHRASES) expect(phrase).toMatch(/^[\p{L} ']+$/u);
	});

	it('refuses an accepted or edited draft with an unbacked claim when the corpus loads', () => {
		const file = (thread: unknown) => ({ version: 1, slice: 'team_notes', threads: [thread] });
		const withDraft = (acceptance: string) => ({
			...team003,
			labels: {
				...team003.labels,
				decisions: [
					{
						...team003.labels.decisions[0],
						drafts: [{ id: 'd1', text: OLD_TEAM_003, acceptance, reason: 'x' }],
					},
				],
			},
		});
		expect(() => parseEvalCorpus([file(withDraft('accept'))])).toThrow(
			/claims: we've noted, ends on/
		);
		expect(() => parseEvalCorpus([file(withDraft('edit'))])).toThrow(/is edit but claims/);
		expect(() => parseEvalCorpus([file(withDraft('reject'))])).not.toThrow();
	});
});
