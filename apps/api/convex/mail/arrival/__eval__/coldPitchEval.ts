/**
 * The cold-pitch evaluation (#1381): R2's own cold-pitch prompt
 * (`../r2.ts r2QuestionsPrompt`) over the labelled sample
 * (`coldPitchSample.ts`), scored against the release gate. The
 * `postbox.coldPitch` flag stays off until a run passes it.
 *
 * The gate puts false positives first: a pitch the question misses only stays
 * where it would have been without the feature, but a real first-contact
 * message judged a pitch leaves the Answer queue. So a run passes with no
 * false positive at all and a recall of at least {@link COLD_PITCH_GATE}'s
 * `minRecall`.
 *
 * The model call is injected (`ColdPitchAsk`); tests pass a scripted one and
 * the CLI (`apps/api/scripts/cold-pitch-eval.ts`) an AI SDK call. Pure and
 * isolate-safe.
 */

import { z } from 'zod';
import { r2ColdPitchSchema, r2QuestionsPrompt } from '../r2';
import type { ColdPitchSample } from './coldPitchSample';

/** The schema of one evaluation call: the cold-pitch part of R2's schema alone. */
export const coldPitchEvalSchema = z.object({ coldPitch: r2ColdPitchSchema });

/** One evaluation call: the prompt in, the model's answer out (undefined when it gave none). */
export type ColdPitchAsk = (
	prompt: string
) => Promise<z.infer<typeof r2ColdPitchSchema> | undefined>;

/** What a run must reach before the flag may be turned on. */
export const COLD_PITCH_GATE = { maxFalsePositives: 0, minRecall: 0.8 } as const;

export interface ColdPitchEvalReport {
	samples: number;
	pitches: number;
	truePositives: number;
	falsePositives: number;
	/** Pitches answered no or unknown. */
	falseNegatives: number;
	precision: number;
	recall: number;
	/** Not-pitch samples judged a pitch, by id: the release blockers. */
	falsePositiveIds: string[];
	missedIds: string[];
	/** Samples whose call failed (counted as no answer, so never a positive). */
	failedIds: string[];
	gate: 'passed' | 'failed';
}

/** The prompt R2 sends for one sample, without rule questions. Pure. */
export function coldPitchEvalPrompt(sample: Pick<ColdPitchSample, 'subject' | 'text'>): string {
	return r2QuestionsPrompt(
		[],
		{
			subject: sample.subject,
			segments: [{ id: 's0', kind: 'fresh', text: sample.text, start: 0, end: sample.text.length }],
		},
		{ isColdPitchAsked: true }
	);
}

/** Score a run (see the module doc). Pure. */
export function scoreColdPitchRun(
	samples: readonly ColdPitchSample[],
	answers: ReadonlyMap<string, z.infer<typeof r2ColdPitchSchema> | undefined>,
	failedIds: readonly string[] = []
): ColdPitchEvalReport {
	const falsePositiveIds: string[] = [];
	const missedIds: string[] = [];
	let truePositives = 0;
	for (const sample of samples) {
		const isYes = answers.get(sample.id) === 'yes';
		if (sample.label === 'pitch' && isYes) truePositives += 1;
		if (sample.label === 'pitch' && !isYes) missedIds.push(sample.id);
		if (sample.label === 'not_pitch' && isYes) falsePositiveIds.push(sample.id);
	}
	const pitches = samples.filter((sample) => sample.label === 'pitch').length;
	const predicted = truePositives + falsePositiveIds.length;
	const recall = pitches === 0 ? 0 : truePositives / pitches;
	const isPassing =
		falsePositiveIds.length <= COLD_PITCH_GATE.maxFalsePositives &&
		recall >= COLD_PITCH_GATE.minRecall;
	return {
		samples: samples.length,
		pitches,
		truePositives,
		falsePositives: falsePositiveIds.length,
		falseNegatives: missedIds.length,
		precision: predicted === 0 ? 0 : truePositives / predicted,
		recall,
		falsePositiveIds,
		missedIds,
		failedIds: [...failedIds],
		gate: isPassing ? 'passed' : 'failed',
	};
}

/** Ask every sample, in order, and score the run. A failed call is no answer. */
export async function runColdPitchEval(
	samples: readonly ColdPitchSample[],
	ask: ColdPitchAsk
): Promise<ColdPitchEvalReport> {
	const answers = new Map<string, z.infer<typeof r2ColdPitchSchema> | undefined>();
	const failedIds: string[] = [];
	for (const sample of samples) {
		try {
			answers.set(sample.id, await ask(coldPitchEvalPrompt(sample)));
		} catch {
			failedIds.push(sample.id);
		}
	}
	return scoreColdPitchRun(samples, answers, failedIds);
}

/** The report as console lines. Pure. */
export function formatColdPitchReport(model: string, report: ColdPitchEvalReport): string {
	const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
	const list = (ids: readonly string[]) => (ids.length > 0 ? ids.join(', ') : 'none');
	return [
		`Cold-pitch eval (${model}): ${report.samples} samples, ${report.pitches} pitches`,
		`  precision ${pct(report.precision)}, recall ${pct(report.recall)}`,
		`  false positives (release blockers): ${list(report.falsePositiveIds)}`,
		`  missed pitches: ${list(report.missedIds)}`,
		`  failed calls: ${list(report.failedIds)}`,
		`  gate (no false positive, recall >= ${pct(COLD_PITCH_GATE.minRecall)}): ${report.gate}`,
	].join('\n');
}
