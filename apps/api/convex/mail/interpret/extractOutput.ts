'use node';

/**
 * The model step of an interpretation run (`run.ts`, split out at the file-size
 * cap): ask the model for the proposals, or take the output a verifier budget
 * deferral stored (`deferredOutput.ts`, Sol r3 F4), validated and clamped the
 * same way either way.
 */

import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { resolveLanguageModel } from '../../lib/llmProvider';
import { runLlmObject } from '../../lib/llm/dispatch';
import { meterLlmCall } from '../../analytics/meteredSpend';
import { cachedPromptInput } from '../../lib/llm/promptCacheInput';
import type { LlmRootContext } from '../../lib/llm/requestMeter';
import type { AdmissionPriority } from '../../lib/validators/aiRouting';
import type { InterpretMode } from '@owlat/shared/threadBrief';
import { interpretOutputSchema, interpretOutputSchemaFor, type InterpretOutput } from './schema';
import { buildInterpretPromptParts } from './prompt';
import { clampOutput } from './clamp';
import type { buildInterpretInput } from './pipeline';

const INTERPRET_FEATURE = 'interpret';

/** Validate with the lenient parse schema (the model schema only shapes the request). */
function validated(object: unknown): InterpretOutput {
	return clampOutput(interpretOutputSchema.parse(object) as InterpretOutput);
}

/** The model's proposals for `input`, metered as `interpret`. */
export async function extractOutput(
	ctx: ActionCtx,
	opts: {
		input: ReturnType<typeof buildInterpretInput>;
		mode: InterpretMode;
		root: LlmRootContext;
		priority: AdmissionPriority;
	}
): Promise<InterpretOutput> {
	const model = await resolveLanguageModel(ctx, 'extract');
	const parts = buildInterpretPromptParts(opts.input);
	const prompt = await cachedPromptInput(ctx, 'mail.extract', model, parts);
	const { object } = await meterLlmCall(
		ctx,
		{ feature: INTERPRET_FEATURE, root: opts.root, priority: opts.priority },
		(meter) =>
			runLlmObject({
				meter,
				model,
				schema: interpretOutputSchemaFor(opts.mode),
				...prompt,
				temperature: 0,
			}),
		// A lost ledger row under-counts; dropping the interpretation over it would be worse.
		{ onWriteError: 'ignore' }
	);
	return validated(object);
}

/** The output a verifier budget deferral stored on the row, or null (extract again). */
export async function storedDeferredOutput(
	ctx: ActionCtx,
	interpretationId: Id<'messageInterpretations'>
): Promise<InterpretOutput | null> {
	const json = await ctx.runQuery(internal.mail.interpret.deferredOutput.readDeferredOutput, {
		interpretationId,
	});
	if (json === null) return null;
	try {
		return validated(JSON.parse(json));
	} catch {
		return null;
	}
}
