/**
 * The non-interactive calls the provider batch path carries (ADR-0073, L14),
 * and its clock. Pure and runtime-neutral: the consumers (`knowledge/
 * extraction.ts`, `semanticFileProcessing.ts`), the item mutations
 * (`aiRouting/batchItems.ts`) and the poller (`aiRouting/batchPoller.ts`)
 * share it.
 */

import type { AiTaskName } from '@owlat/shared/aiRouting';
import type { BatchConsumer } from '../validators/aiRouting';
import { BATCH_COMPLETION_WINDOW_MS } from '../llm/batch/transport';
import { BATCH_ENDPOINT_SUFFIX } from '../llm/pricing';

/** Each consumer's task and the ledger feature its real-time call records under. */
export const BATCH_CONSUMER_SPECS: Readonly<
	Record<BatchConsumer, { readonly task: AiTaskName; readonly feature: string }>
> = {
	knowledge_message: { task: 'knowledge.extract', feature: 'knowledge_extract_message' },
	knowledge_file: { task: 'knowledge.extract', feature: 'knowledge_extract_file' },
	knowledge_mail: { task: 'knowledge.extract', feature: 'knowledge_extract_mail' },
	file_summary: { task: 'file.summarize', feature: 'semantic_file' },
};

/** A source's key: at most one item per source is live. */
export function batchItemKey(consumer: BatchConsumer, sourceId: string): string {
	return `${consumer}:${sourceId}`;
}

/** How often a submitted item is asked about. */
export const BATCH_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** How long an unconfirmed submission waits before it is taken as lost. */
export const BATCH_SUBMIT_GRACE_MS = 15 * 60 * 1000;

/**
 * How long an item, and its hold, lives: the provider's completion window,
 * plus time for the poller to read the result. Past it the item is abandoned
 * and the expiry sweep charges the hold in full.
 */
export const BATCH_ITEM_LIFETIME_MS = BATCH_COMPLETION_WINDOW_MS + 2 * 60 * 60 * 1000;

/** The ledger `endpoint` of a batch request: the provider's, marked as batched (priced at the batch rate). */
export function batchEndpoint(provider: string): string {
	return `${provider}${BATCH_ENDPOINT_SUFFIX}`;
}
