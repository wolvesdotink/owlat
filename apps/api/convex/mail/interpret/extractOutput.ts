'use node';

/**
 * The model step of an interpretation run (`run.ts`, split out at the file-size
 * cap): resolve the model and build the prompt first, so the run can size its
 * one hold from them (`runHold.ts`), then ask the model under that hold.
 */

import type { LanguageModel } from 'ai';
import type { ActionCtx } from '../../_generated/server';
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
import type { InterpretRunHold } from './runHold';

const INTERPRET_FEATURE = 'interpret';

/** The extraction call, ready to size and to send. */
export interface PreparedExtraction {
	readonly model: LanguageModel;
	readonly prompt: Awaited<ReturnType<typeof cachedPromptInput>>;
	readonly schema: ReturnType<typeof interpretOutputSchemaFor>;
}

export async function prepareExtraction(
	ctx: ActionCtx,
	input: ReturnType<typeof buildInterpretInput>,
	mode: InterpretMode
): Promise<PreparedExtraction> {
	const model = await resolveLanguageModel(ctx, 'extract');
	const prompt = await cachedPromptInput(
		ctx,
		'mail.extract',
		model,
		buildInterpretPromptParts(input)
	);
	return { model, prompt, schema: interpretOutputSchemaFor(mode) };
}

/** The model's proposals, metered as `interpret` under the run's hold. */
export async function extractOutput(
	ctx: ActionCtx,
	prepared: PreparedExtraction,
	opts: { root: LlmRootContext; priority: AdmissionPriority; hold: InterpretRunHold }
): Promise<InterpretOutput> {
	const { object } = await meterLlmCall(
		ctx,
		{ feature: INTERPRET_FEATURE, root: opts.root, priority: opts.priority, ...opts.hold.target },
		async (meter) => {
			try {
				return await runLlmObject({
					meter,
					model: prepared.model,
					schema: prepared.schema,
					...prepared.prompt,
					temperature: 0,
				});
			} finally {
				opts.hold.count(meter.requests.length);
			}
		},
		// A lost ledger row under-counts; dropping the interpretation over it would be worse.
		{ onWriteError: 'ignore' }
	);
	// Validate with the lenient parse schema (the model schema only shapes the request).
	return clampOutput(interpretOutputSchema.parse(object) as InterpretOutput);
}
