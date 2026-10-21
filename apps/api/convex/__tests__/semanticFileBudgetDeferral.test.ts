/**
 * A semantic file whose paid stages spend admission refuses at the dispatch
 * owes them to a later run: the refused stages
 * travel in the scheduled run's arguments, a summary that already landed is
 * reused, and the retries are bounded.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { newHarness } from './testModules';
import { AdmissionRefusedError } from '../lib/llm/admissionPort';
import { MAX_FILE_DEFERRALS } from '../analytics/backgroundDeferral';

const mocks = vi.hoisted(() => ({
	summarizeFile: vi.fn(),
	runEmbedding: vi.fn(),
	sendSummaryThroughBatch: vi.fn(),
}));

vi.mock('../lib/semanticFileAi', () => ({
	aiProviderConfigured: vi.fn(async () => true),
	// Off (the default) unless a test says otherwise: a real-time summary.
	sendSummaryThroughBatch: (...args: unknown[]) => mocks.sendSummaryThroughBatch(...args),
	summarizeFile: (...args: unknown[]) => mocks.summarizeFile(...args),
}));
vi.mock('../lib/llm/embed', () => ({
	runEmbedding: (...args: unknown[]) => mocks.runEmbedding(...args),
}));
vi.mock('../lib/aiRouting/embeddingProbe', () => ({
	probeEmbeddingRevision: vi.fn(async () => undefined),
	measuredEmbeddingSpace: vi.fn(async () => undefined),
}));
vi.mock('../lib/llmProvider', async (importOriginal) => ({
	...(await importOriginal<object>()),
	resolveIndexEmbedder: vi.fn(async () => ({
		model: { modelId: 'text-embedding-3-small' },
		embeddingSpaceKey: 'space-key',
	})),
}));

// Over 50 characters (a summary is asked for), under 80 (no knowledge extraction).
const BODY = 'Quarterly budget review: hosting spend rose eleven percent this year.';

async function insertTextFile(t: ReturnType<typeof newHarness>): Promise<Id<'semanticFiles'>> {
	const storageId = await t.run((ctx) => ctx.storage.store(new Blob([BODY])));
	const now = Date.now();
	return t.run((ctx) =>
		ctx.db.insert('semanticFiles', {
			storageId,
			filename: 'budget.txt',
			mimeType: 'text/plain',
			fileSize: BODY.length,
			sourceType: 'email_attachment',
			tags: [],
			version: 1,
			embedding: [],
			searchableText: 'budget.txt',
			createdAt: now,
			updatedAt: now,
		})
	);
}

async function scheduledRuns(t: ReturnType<typeof newHarness>) {
	const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
	return jobs
		.filter((job) => job.name.includes('processFile') && job.state.kind === 'pending')
		.map((job) => job.args[0] as { deferrals?: number; stages?: string[] });
}

const refused = () => new AdmissionRefusedError('daily_ceiling', 'ceiling');

beforeEach(() => {
	vi.useFakeTimers();
	mocks.summarizeFile.mockReset();
	mocks.runEmbedding.mockReset();
	mocks.sendSummaryThroughBatch.mockReset();
	mocks.sendSummaryThroughBatch.mockResolvedValue(false);
});

describe('processFile under dispatch-time admission refusals', () => {
	it('owes the summary and the embedding when the summary is refused', async () => {
		const t = newHarness();
		const fileId = await insertTextFile(t);
		mocks.summarizeFile.mockRejectedValue(refused());
		mocks.runEmbedding.mockRejectedValue(new Error('embedder down'));

		await t.action(internal.semanticFileProcessing.processFile, { fileId });

		expect(await scheduledRuns(t)).toEqual([
			{ fileId, deferrals: 1, stages: ['summary', 'embedding'] },
		]);
		vi.useRealTimers();
	});

	it('owes only the embedding when only it is refused, and reuses the stored summary', async () => {
		const t = newHarness();
		const fileId = await insertTextFile(t);
		mocks.summarizeFile.mockResolvedValue({
			title: 'Budget',
			summary: 'Spend rose.',
			tags: ['budget'],
		});
		mocks.runEmbedding.mockRejectedValue(refused());

		await t.action(internal.semanticFileProcessing.processFile, { fileId });
		expect(await scheduledRuns(t)).toEqual([{ fileId, deferrals: 1, stages: ['embedding'] }]);
		expect((await t.run((ctx) => ctx.db.get(fileId)))?.summary).toBe('Spend rose.');

		// The owed run asks no model for the summary again.
		await t.action(internal.semanticFileProcessing.processFile, {
			fileId,
			deferrals: 1,
			stages: ['embedding'],
		});
		expect(mocks.summarizeFile).toHaveBeenCalledTimes(1);
		expect((await t.run((ctx) => ctx.db.get(fileId)))?.summary).toBe('Spend rose.');
		vi.useRealTimers();
	});

	it('stops rescheduling after the last deferral', async () => {
		const t = newHarness();
		const fileId = await insertTextFile(t);
		mocks.summarizeFile.mockRejectedValue(refused());
		mocks.runEmbedding.mockRejectedValue(refused());

		await t.action(internal.semanticFileProcessing.processFile, {
			fileId,
			deferrals: MAX_FILE_DEFERRALS,
		});
		expect(await scheduledRuns(t)).toEqual([]);
		vi.useRealTimers();
	});

	it('schedules nothing for an ordinary model failure (the backfill owns those)', async () => {
		const t = newHarness();
		const fileId = await insertTextFile(t);
		mocks.summarizeFile.mockRejectedValue(new Error('provider down'));
		mocks.runEmbedding.mockRejectedValue(new Error('embedder down'));

		await t.action(internal.semanticFileProcessing.processFile, { fileId });
		expect(await scheduledRuns(t)).toEqual([]);
		vi.useRealTimers();
	});
});

describe('processFile with the provider batch path (L14)', () => {
	it('sends the summary to the batch and leaves the embedding for its result', async () => {
		const t = newHarness();
		const fileId = await insertTextFile(t);
		mocks.sendSummaryThroughBatch.mockResolvedValue(true);

		await t.action(internal.semanticFileProcessing.processFile, { fileId });

		expect(mocks.sendSummaryThroughBatch).toHaveBeenCalledTimes(1);
		expect(mocks.summarizeFile).not.toHaveBeenCalled();
		expect(mocks.runEmbedding).not.toHaveBeenCalled();
		const file = await t.run((ctx) => ctx.db.get(fileId));
		// The text is searchable now; the summary comes with the batch result.
		expect(file?.extractedText).toBe(BODY);
		expect(file?.summary).toBe('');
		expect(await scheduledRuns(t)).toEqual([]);
		vi.useRealTimers();
	});

	it('uses a batched summary instead of asking the model, and embeds it', async () => {
		const t = newHarness();
		const fileId = await insertTextFile(t);
		mocks.runEmbedding.mockResolvedValue({ embedding: [0.1, 0.2], usage: { tokens: 3 } });

		await t.action(internal.semanticFileProcessing.processFile, {
			fileId,
			batchedSummary: { title: 'Budget', summary: 'Spend rose.', tags: ['budget'] },
		});

		expect(mocks.sendSummaryThroughBatch).not.toHaveBeenCalled();
		expect(mocks.summarizeFile).not.toHaveBeenCalled();
		expect(mocks.runEmbedding).toHaveBeenCalledTimes(1);
		const file = await t.run((ctx) => ctx.db.get(fileId));
		expect(file).toMatchObject({ title: 'Budget', summary: 'Spend rose.' });
		expect(file?.autoTags).toContain('budget');
		vi.useRealTimers();
	});

	it('keeps a batched summary through a budget deferral of the run', async () => {
		vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '10');
		const t = newHarness();
		const fileId = await insertTextFile(t);
		const batchedSummary = { title: 'Budget', summary: 'Spend rose.', tags: ['budget'] };

		// The spend state is not reconciled: background work has no headroom.
		await t.action(internal.semanticFileProcessing.processFile, { fileId, batchedSummary });

		expect(await scheduledRuns(t)).toEqual([{ fileId, deferrals: 1, batchedSummary }]);
		vi.unstubAllEnvs();
		vi.useRealTimers();
	});
});
