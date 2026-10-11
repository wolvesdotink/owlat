/**
 * The corpus splits (`train`, `calibration`, `heldout`) and the checks that
 * keep them honest. Prompts and question criteria are developed against
 * training threads; thresholds and calibration maps are fitted on calibration
 * threads; only held-out threads are reported. The split is written into each
 * thread (`corpus.ts`), so adding a thread never moves an existing one.
 *
 * {@link splitIntegrityProblems} lists what would make a held-out number
 * meaningless: a split without a language, a surface or a class it is
 * reported on, or the same message text in two splits (a model tuned on one
 * copy would be graded on the other).
 *
 * Pure and isolate-safe.
 */
import type { EvalThread } from './corpus';
import { EVAL_SPLITS, type DecisionLabel, type EvalSplit } from './decisionLabels';

/** Threads of one split, or the whole corpus. */
export function threadsInSplit(
	corpus: readonly EvalThread[],
	split: EvalSplit | 'all'
): EvalThread[] {
	return split === 'all' ? [...corpus] : corpus.filter((t) => t.split === split);
}

const decisionsOf = (threads: readonly EvalThread[]): DecisionLabel[] =>
	threads.flatMap((t) => t.labels.decisions);

/** Every value a split must contain at least once, by what it is read from. */
const REQUIRED: readonly {
	name: string;
	values: readonly string[];
	read: (threads: readonly EvalThread[]) => readonly (string | undefined)[];
}[] = [
	{ name: 'locale', values: ['en', 'de'], read: (ts) => ts.map((t) => t.locale) },
	{ name: 'mode', values: ['brief', 'actions'], read: (ts) => ts.map((t) => t.mode) },
	{
		name: 'triage',
		values: ['spam', 'automated', 'needs_work', 'no_work'],
		read: (ts) => decisionsOf(ts).map((d) => d.triage),
	},
	{
		name: 'disposition',
		values: ['reply', 'informational'],
		read: (ts) => decisionsOf(ts).map((d) => d.disposition),
	},
	{
		name: 'necessity',
		values: ['needed', 'not_needed'],
		read: (ts) => decisionsOf(ts).map((d) => d.clarification?.necessity),
	},
	{
		name: 'draft acceptance',
		values: ['accept', 'reject'],
		read: (ts) => decisionsOf(ts).flatMap((d) => d.drafts?.map((x) => x.acceptance) ?? []),
	},
];

/** Message text as compared across splits: case and whitespace folded. */
function fingerprint(text: string): string {
	return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Problems that make a split unfit for its job; empty when the corpus is sound.
 * `minShare` is the smallest fraction of threads each split must hold.
 */
export function splitIntegrityProblems(corpus: readonly EvalThread[], minShare = 0.2): string[] {
	const problems: string[] = [];
	for (const split of EVAL_SPLITS) {
		const threads = threadsInSplit(corpus, split);
		if (threads.length < minShare * corpus.length) {
			problems.push(`${split}: ${threads.length} of ${corpus.length} threads`);
		}
		for (const { name, values, read } of REQUIRED) {
			const present = new Set(read(threads));
			for (const value of values) {
				if (!present.has(value)) problems.push(`${split}: no ${name} ${value}`);
			}
		}
	}
	const owner = new Map<string, { split: EvalSplit; threadId: string }>();
	for (const thread of corpus) {
		for (const message of thread.messages) {
			const body = message.text ?? message.html;
			if (!body) continue;
			const key = fingerprint(body);
			const seen = owner.get(key);
			if (seen && seen.split !== thread.split) {
				problems.push(
					`${thread.id}/${message.id} repeats a ${seen.split} message (${seen.threadId}) in ${thread.split}`
				);
			}
			if (!seen) owner.set(key, { split: thread.split, threadId: thread.id });
		}
	}
	return problems;
}
