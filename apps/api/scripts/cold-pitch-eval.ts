/**
 * Run the cold-pitch question over its labelled sample and check the
 * release gate before anyone turns `postbox.coldPitch` on:
 *
 *   bun apps/api/scripts/cold-pitch-eval.ts
 *
 * A live run needs a model and its key in the environment, the same switch as
 * the other eval scripts (`evalSupport.ts`):
 *   INTERPRET_EVAL_MODEL=<model id> plus ANTHROPIC_API_KEY or OPENAI_API_KEY
 * Use the model the instance routes `mail.classify` to. It sends each sample
 * through R2's own cold-pitch prompt, prints precision, recall, every false
 * positive and missed pitch, and exits non-zero when the gate fails.
 *
 * With no model configured nothing reaches a provider: it prints the sample's
 * size and exits zero.
 */
import { COLD_PITCH_SAMPLE } from '../convex/mail/arrival/__eval__/coldPitchSample';
import {
	coldPitchEvalSchema,
	formatColdPitchReport,
	runColdPitchEval,
} from '../convex/mail/arrival/__eval__/coldPitchEval';
import { evalLanguageModelFromEnv } from './evalSupport';

const live = await evalLanguageModelFromEnv();
if (!live) {
	const pitches = COLD_PITCH_SAMPLE.filter((sample) => sample.label === 'pitch').length;
	console.info(
		`No model configured: ${COLD_PITCH_SAMPLE.length} labelled samples (${pitches} pitches), nothing asked.`
	);
	process.exit(0);
}

const { generateObject } = await import('ai');
const report = await runColdPitchEval(COLD_PITCH_SAMPLE, async (prompt) => {
	const { object } = await generateObject({
		model: live.model,
		schema: coldPitchEvalSchema,
		prompt,
		temperature: 0,
	});
	return object.coldPitch;
});
console.info(formatColdPitchReport(live.modelId, report));
process.exit(report.gate === 'passed' ? 0 : 1);
