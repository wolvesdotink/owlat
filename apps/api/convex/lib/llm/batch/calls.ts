'use node';

/**
 * The structured call each batch consumer makes (ADR-0073, L14): its task, its
 * output schema and temperature, and how its parsed output is handed on. The
 * consumer captures its request with these, and the poller reads the result
 * with the same schema, so a batch request and its reading are the real-time
 * call's.
 */

import type { z } from 'zod';
import type { AiTaskName } from '@owlat/shared/aiRouting';
import type { BatchConsumer } from '../../validators/aiRouting';
import { BATCH_CONSUMER_SPECS } from '../../aiRouting/batchConsumers';
import { extractionSchema, type ExtractedEntry } from '../../../knowledge/extractedEntries';
import { summarySchema } from '../../semanticFileSummary';

/** What a consumer's result continues as. */
export type BatchOutput =
	| { readonly kind: 'entries'; readonly entries: ExtractedEntry[] }
	| {
			readonly kind: 'summary';
			readonly summary: { title: string; summary: string; tags: string[] };
	  };

export interface BatchCall {
	readonly task: AiTaskName;
	readonly schema: z.ZodTypeAny;
	readonly temperature?: number;
	/** The parsed object as the consumer continues with it. */
	readonly output: (object: unknown) => BatchOutput;
}

/** The knowledge extraction's temperature (`knowledge/extraction.ts`). */
export const EXTRACTION_TEMPERATURE = 0.1;

const extraction = (consumer: BatchConsumer): BatchCall => ({
	task: BATCH_CONSUMER_SPECS[consumer].task,
	schema: extractionSchema,
	temperature: EXTRACTION_TEMPERATURE,
	output: (object) => ({
		kind: 'entries',
		entries: (object as z.infer<typeof extractionSchema>).entries ?? [],
	}),
});

/** The call of `consumer`. */
export function batchCallOf(consumer: BatchConsumer): BatchCall {
	if (consumer !== 'file_summary') return extraction(consumer);
	return {
		task: BATCH_CONSUMER_SPECS.file_summary.task,
		schema: summarySchema,
		output: (object) => {
			const parsed = object as z.infer<typeof summarySchema>;
			return {
				kind: 'summary',
				summary: { title: parsed.title, summary: parsed.summary, tags: parsed.tags },
			};
		},
	};
}
