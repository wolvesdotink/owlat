/**
 * Run the interpretation eval over the corpus and print its metrics:
 *
 *   bun apps/api/scripts/interpret-eval.ts [corpus-dir]
 *
 * With no model configured it replays the labels themselves (the oracle), so
 * the numbers measure segmentation and grounding alone and must be perfect.
 * The live-model path is wired by the interpret lane through `EvalModel`
 * (`convex/mail/interpret/__eval__/runEval.ts`); until then this is the
 * deterministic replay. Exits non-zero when the oracle replay is not perfect.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEvalCorpus } from '../convex/mail/interpret/__eval__/corpus';
import { formatEvalReport, runEval } from '../convex/mail/interpret/__eval__/runEval';

const dir =
	process.argv[2] ??
	join(import.meta.dirname, '..', 'convex', 'mail', 'interpret', '__eval__', 'corpus');
const files = readdirSync(dir)
	.filter((name) => name.endsWith('.json'))
	.sort()
	.map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown);

const report = await runEval(parseEvalCorpus(files));
console.info('No model configured: replaying the labels (oracle).');
console.info(formatEvalReport(report));

const perfect =
	report.recall === 1 &&
	report.precision === 1 &&
	report.ownership === 1 &&
	report.evidenceValidity === 1 &&
	report.trapsAccepted.length === 0 &&
	report.flagsMissed.length === 0 &&
	report.notesLeaked.length === 0;
process.exit(perfect ? 0 : 1);
