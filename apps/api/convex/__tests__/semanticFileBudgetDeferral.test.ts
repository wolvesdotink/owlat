/**
 * A semantic file whose paid stages spend admission refuses at the dispatch
 * (ADR-0073, D1, Sol r1 F8) owes them to a later run: the refused stages
 * travel in the scheduled run's arguments, a summary that already landed is
 * reused, and the retries are bounded.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { newHarness } from './testModules';
import { AdmissionRefusedError } from '../lib/llm/admissionPort';
import { MAX_FILE_DEFERRALS } from '../analytics/backgroundDeferral';

const mocks = vi.hoisted(() => ({ summarizeFile: vi.fn(), runEmbedding: vi.fn() }));

vi.mock('../lib/semanticFileAi', () => ({
	aiProviderConfigured: vi.fn(async () => true),
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
