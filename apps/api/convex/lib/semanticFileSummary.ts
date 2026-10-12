/**
 * A file's summary as the model returns it: its title, two or three sentences
 * and tags. Shared by the real-time call (`./semanticFileAi.ts`) and the batch
 * path, which reads a batch result with the same schema
 * (`./llm/batch/calls.ts`). Pure.
 */

import { z } from 'zod';

export const summarySchema = z.object({
	title: z.string().describe('Short descriptive title for the file'),
	summary: z.string().describe('2-3 sentence summary of the file content'),
	tags: z.array(z.string()).describe('5-10 relevant tags for categorization'),
});
