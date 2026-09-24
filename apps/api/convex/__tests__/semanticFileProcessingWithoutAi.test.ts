import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { __resetAiConfigCacheForTests } from '../lib/llmProvider';
import { newHarness } from './testModules';

/**
 * AI is optional. An instance with no provider set up still captures inbound
 * attachments and uploads, and `processFile` runs for each of them. It used to
 * throw "LLM API not configured" at the embedding step, so the file never got
 * its extracted text or search text, and the backfill re-ran it into the same
 * error. Without a provider it now stores everything that needs no model.
 */

const LLM_ENV_KEYS = ['LLM_PROVIDER', 'LLM_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY'];

const BODY =
	'Quarterly budget review for the platform team. Hosting spend rose eleven percent ' +
	'while support tickets fell, so the plan moves two contractors onto onboarding.';

async function insertTextFile(
	t: ReturnType<typeof newHarness>,
	text: string
): Promise<Id<'semanticFiles'>> {
	const storageId = await t.run((ctx) => ctx.storage.store(new Blob([text])));
	const now = Date.now();
	return await t.run((ctx) =>
		ctx.db.insert('semanticFiles', {
			storageId,
			filename: 'budget-review.txt',
			mimeType: 'text/plain',
			fileSize: text.length,
			sourceType: 'email_attachment',
			tags: ['finance'],
			version: 1,
			embedding: [],
			searchableText: 'budget-review.txt finance',
			createdAt: now,
			updatedAt: now,
		})
	);
}

beforeEach(() => {
	for (const key of LLM_ENV_KEYS) vi.stubEnv(key, undefined);
	__resetAiConfigCacheForTests();
});

afterEach(() => {
	vi.unstubAllEnvs();
	__resetAiConfigCacheForTests();
});

describe('processFile without an AI provider', () => {
	it('stores the extracted text and search text instead of throwing', async () => {
		const t = newHarness();
		const fileId = await insertTextFile(t, BODY);

		await t.action(internal.semanticFileProcessing.processFile, { fileId });

		const file = await t.run((ctx) => ctx.db.get(fileId));
		expect(file).toMatchObject({
			extractedText: BODY,
			title: 'budget-review.txt',
			summary: '',
			embedding: [],
		});
		expect(file?.embeddingModel).toBeUndefined();
		expect(file?.searchableText).toContain('Hosting spend rose eleven percent');
		expect(file?.searchableText).toContain('finance');
		// No knowledge extraction without a model to extract with.
		const entries = await t.run((ctx) => ctx.db.query('knowledgeEntries').collect());
		expect(entries).toEqual([]);
	});

	it('still fails loudly when a provider is set up but unusable', async () => {
		vi.stubEnv('LLM_API_KEY', 'sk-test');
		vi.stubEnv('LLM_EMBEDDING_MODEL', 'text-embedding-3-large');
		const t = newHarness();
		// Short enough to skip the summary call, long enough to be embedded.
		const fileId = await insertTextFile(t, 'Budget notes for Q3');

		await expect(t.action(internal.semanticFileProcessing.processFile, { fileId })).rejects.toThrow(
			/3072-dimensional/
		);
	});
});
