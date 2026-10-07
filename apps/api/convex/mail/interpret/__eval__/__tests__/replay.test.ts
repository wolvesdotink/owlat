/**
 * Deterministic replay of the seed eval corpus: with the labels standing in
 * for a perfect model, every labelled quote must ground, every trap must be
 * rejected for the labelled reason, internal notes must never reach the model
 * input, and the metrics must come out perfect. A failure here is a
 * segmentation or grounding defect (or a mislabelled thread), not a model one.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVAL_SLICES, parseEvalCorpus, type EvalThread } from '../corpus';
import { arrivalOrder, modelInputFor, replayThread } from '../replay';
import { formatEvalReport, runEval, type EvalModel } from '../runEval';
import type { EvalModelInput } from '../replay';

const CORPUS_DIR = join(import.meta.dirname, '..', 'corpus');
const files = readdirSync(CORPUS_DIR)
	.filter((f) => f.endsWith('.json'))
	.sort()
	.map((f) => JSON.parse(readFileSync(join(CORPUS_DIR, f), 'utf8')) as unknown);
const corpus = parseEvalCorpus(files);
const eligible = corpus.filter((t) => !t.expectIneligible);

describe('eval corpus', () => {
	it('holds at least 60 labelled threads covering every plan §14 slice', () => {
		expect(corpus.length).toBeGreaterThanOrEqual(60);
		for (const slice of EVAL_SLICES) {
			expect(corpus.filter((t) => t.slices.includes(slice)).length, slice).toBeGreaterThanOrEqual(
				4
			);
		}
		expect(corpus.filter((t) => t.locale === 'de').length).toBeGreaterThanOrEqual(15);
		expect(
			corpus.filter((t) => t.slices.includes('long_threads')).every((t) => t.messages.length > 15)
		).toBe(true);
		expect(
			corpus.filter((t) => t.slices.includes('team_notes')).every((t) => t.mode === 'actions')
		).toBe(true);
	});

	it('uses fictional example domains only', () => {
		const addresses = JSON.stringify(corpus).match(/[\w.+-]+@[\w.-]+/g) ?? [];
		for (const address of addresses)
			expect(address).toMatch(/@(?:[\w-]+\.)*example(?:\.(?:com|org|net))?$/);
	});

	it('marks bulk mail from strangers ineligible, with nothing labelled', () => {
		for (const thread of corpus.filter((t) => t.expectIneligible)) {
			expect(thread.labels.items).toEqual([]);
			expect(thread.messages.every((m) => m.headers?.listUnsubscribe)).toBe(true);
		}
	});

	it('rejects malformed corpus files', () => {
		const thread = corpus[0] as EvalThread;
		const file = (threads: unknown[]) => ({ version: 1, slice: 'en', threads });
		expect(() => parseEvalCorpus([file([thread, thread])])).toThrow(/duplicate/);
		const orphan = {
			...thread,
			id: 'x',
			labels: { items: [{ ...thread.labels.items[0], messageId: 'nope' }] },
		};
		expect(() => parseEvalCorpus([file([orphan])])).toThrow(/unknown message/);
		expect(() => parseEvalCorpus([{ version: 2, slice: 'en', threads: [] }])).toThrow();
	});
});

describe('oracle replay', () => {
	it.each(eligible.map((t) => [t.id, t] as const))(
		'%s grounds every label',
		async (_id, thread) => {
			const replayed = await replayThread(thread);
			for (const { message, grounding, output } of replayed) {
				const labelOf = (index: number) => (output.items[index] as { labelId?: string }).labelId;
				for (const label of thread.labels.items.filter((l) => l.messageId === message.id)) {
					const accepted = grounding.items.find(
						(c) => (c.claim as { labelId?: string }).labelId === label.id
					);
					const rejection = grounding.rejected.find(
						(r) => r.kind === 'item' && labelOf(r.index) === label.id
					);
					expect(accepted, `${label.id}: ${JSON.stringify(rejection)}`).toBeDefined();
					expect(accepted?.needsReview, label.id).toBe(label.expect === 'flagged');
				}
				for (const trap of (thread.labels.traps ?? []).filter((l) => l.messageId === message.id)) {
					const rejection = grounding.rejected.find(
						(r) => r.kind === 'item' && labelOf(r.index) === trap.id
					);
					expect(rejection?.reason, trap.id).toBe(trap.reject);
				}
				const facts = (thread.labels.facts ?? []).filter((l) => l.messageId === message.id);
				expect(grounding.facts?.length ?? 0, `${message.id} facts`).toBe(facts.length);
			}
		}
	);

	it('scores the oracle as perfect', async () => {
		const report = await runEval(corpus);
		expect(report).toMatchObject({
			model: 'oracle',
			recall: 1,
			precision: 1,
			ownership: 1,
			evidenceValidity: 1,
			unsupportedRate: 0,
			costUsd: 0,
			missed: [],
			trapsAccepted: [],
			flagsMissed: [],
			notesLeaked: [],
		});
		expect(report.skippedIneligible).toBe(corpus.length - eligible.length);
		expect(report.labelledItems).toBeGreaterThanOrEqual(60);
		expect(report.worstSlice?.recall).toBe(1);
		const text = formatEvalReport(report);
		for (const metric of [
			'recall',
			'precision',
			'ownership',
			'evidence validity',
			'unsupported rate',
			'cost',
		]) {
			expect(text).toContain(metric);
		}
	});

	it('is deterministic', async () => {
		const thread = eligible.find((t) => t.slices.includes('long_threads')) as EvalThread;
		expect(JSON.stringify(await replayThread(thread))).toBe(
			JSON.stringify(await replayThread(thread))
		);
	});
});

describe('model input', () => {
	it('never carries a team internal note', () => {
		const teamThreads = corpus.filter((t) => (t.internalNotes ?? []).length > 0);
		expect(teamThreads.length).toBeGreaterThanOrEqual(4);
		for (const thread of teamThreads) {
			const input = JSON.stringify(modelInputFor(thread));
			for (const note of thread.internalNotes ?? []) expect(input).not.toContain(note.text);
		}
	});

	it('follows arrival order for out-of-order threads', () => {
		for (const thread of corpus.filter((t) => t.slices.includes('out_of_order'))) {
			const order = arrivalOrder(thread).map((m) => m.arrivalOrder);
			expect(order).toEqual([...order].sort((a, b) => (a ?? 0) - (b ?? 0)));
			expect(modelInputFor(thread).map((m) => m.messageId)).toEqual(
				arrivalOrder(thread).map((m) => m.id)
			);
		}
	});

	it('leaves the text outside a clearsigned block out', () => {
		for (const thread of corpus.filter((t) => t.slices.includes('clearsigned_trailer'))) {
			const input = JSON.stringify(modelInputFor(thread));
			expect(input).not.toContain('BEGIN PGP');
			for (const trap of thread.labels.traps ?? []) expect(input).not.toContain(trap.quote);
		}
	});
});

describe('runEval with a model', () => {
	it('scores misses, unsupported claims and cost', async () => {
		const sample = eligible.filter((t) => t.slices.includes('en')).slice(0, 3);
		const paraphrasing: EvalModel = {
			name: 'paraphraser',
			async interpret({ mode, message, segmented }) {
				const fresh = segmented.segments.find((s) => s.kind === 'fresh');
				return {
					costUsd: 0.002,
					output: {
						mode,
						items: [
							{
								intent: 'request',
								facets: [],
								assertion: 'Do something',
								quotes: [{ segmentId: fresh?.id ?? 's0', text: `not in ${message.messageId}` }],
							},
						],
						transitions: [],
					},
				};
			},
		};
		const report = await runEval(sample, paraphrasing);
		expect(report.model).toBe('paraphraser');
		expect(report.recall).toBe(0);
		expect(report.unsupportedRate).toBe(1);
		expect(report.missed.length).toBe(report.labelledItems);
		expect(report.costUsd).toBeCloseTo(0.002 * report.messages);
	});
});

describe('runEval: what a model adapter receives', () => {
	it('gets sanitized metadata, scoped content and only the history so far', async () => {
		const inputs: EvalModelInput[] = [];
		const recorder: EvalModel = {
			name: 'recorder',
			async interpret(input) {
				inputs.push(input);
				return { output: { mode: input.mode, items: [], transitions: [] } };
			},
		};
		const report = await runEval(corpus, recorder);
		expect(inputs.length).toBe(report.messages);
		expect(report.notesLeaked).toEqual([]);

		const byThread = new Map(eligible.map((t) => [t.id, t] as const));
		let k = 0;
		for (const thread of byThread.values()) {
			const order = arrivalOrder(thread).map((m) => m.id);
			for (const [step, id] of order.entries()) {
				const input = inputs[k++] as EvalModelInput;
				const json = JSON.stringify(input);
				expect(Object.keys(input).sort()).toEqual(
					['history', 'locale', 'message', 'mode', 'segmented', 'us'].sort()
				);
				expect(input.message.messageId).toBe(id);
				// Only messages that arrived before this one.
				expect(input.history.map((m) => m.messageId)).toEqual(order.slice(0, step));
				// No team note, no label, no unsigned trailer.
				for (const note of thread.internalNotes ?? []) expect(json).not.toContain(note.text);
				// A label's assertion may also be words of the mail itself; only one that is
				// not in any body proves a leak.
				const bodies = thread.messages
					.map((m) => `${m.subject}\n${m.text ?? ''}\n${m.html ?? ''}`)
					.join('\n');
				for (const label of [...thread.labels.items, ...(thread.labels.traps ?? [])]) {
					if (!bodies.includes(label.assertion)) expect(json).not.toContain(label.assertion);
				}
				expect(json).not.toMatch(/"labels"|"internalNotes"|"signatureScope"|"arrivalOrder"/);
				if (thread.slices.includes('clearsigned_trailer')) {
					expect(json).not.toContain('BEGIN PGP');
					for (const trap of thread.labels.traps ?? []) expect(json).not.toContain(trap.quote);
				}
			}
		}
		expect(k).toBe(inputs.length);
	});

	it('reports a note that does reach an adapter input', async () => {
		const team = eligible.find((t) => (t.internalNotes ?? []).length > 0) as EvalThread;
		const note = team.internalNotes?.[0];
		if (!note) throw new Error('no team note in corpus');
		const leaky: EvalThread = {
			...team,
			id: 'leaky',
			messages: team.messages.map((m, i) => (i === 0 ? { ...m, subject: note.text } : m)),
		};
		const report = await runEval([leaky]);
		expect(report.notesLeaked).toEqual([{ threadId: 'leaky', noteId: note.id }]);
	});
});
