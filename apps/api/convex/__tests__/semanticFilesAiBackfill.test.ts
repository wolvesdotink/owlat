import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { encryptSecret } from '../lib/credentialCrypto';
import { newHarness } from './testModules';

/**
 * Semantic-file processing and the AI provider's arrival.
 *
 * - Without a provider, `processFile` cannot produce an embedding, so the
 *   15-minute `backfillUnprocessed` re-extracted every new file on each tick
 *   for two hours. It now schedules nothing until a provider exists.
 * - Files processed without a provider never got a summary, embedding or
 *   knowledge entries, and nothing would ever run them again. Saving the
 *   instance's first provider now schedules one bounded pass over them.
 *
 * The scheduled `processFile` runs are only inspected, never run: timers are
 * fake, and no test here advances them.
 */

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	const session = { userId: 'user_admin', role: 'admin' };
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue(session),
		requireOrgPermission: vi.fn().mockResolvedValue(session),
	};
});

const LLM_ENV_KEYS = ['LLM_PROVIDER', 'LLM_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY'];
const PROCESS_FILE = 'semanticFileProcessing:processFile';

type T = ReturnType<typeof newHarness>;

async function insertFile(
	t: T,
	fields: { embedded?: boolean; released?: boolean; ageMs?: number } = {}
): Promise<Id<'semanticFiles'>> {
	const storageId = fields.released
		? undefined
		: await t.run((ctx) => ctx.storage.store(new Blob(['Quarterly budget review'])));
	const createdAt = Date.now() - (fields.ageMs ?? 0);
	return await t.run((ctx) =>
		ctx.db.insert('semanticFiles', {
			storageId,
			filename: 'budget-review.txt',
			mimeType: 'text/plain',
			fileSize: 23,
			sourceType: 'email_attachment',
			tags: [],
			version: 1,
			embedding: fields.embedded ? [0.1, 0.2] : [],
			...(fields.embedded ? { embeddingGeneratedAt: createdAt } : {}),
			searchableText: 'budget-review.txt',
			createdAt,
			updatedAt: createdAt,
		})
	);
}

/** The pending `processFile` jobs: file id and delay from now. */
async function processJobs(t: T): Promise<{ fileId: string; delayMs: number }[]> {
	const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
	return jobs
		.filter((job) => job.name === PROCESS_FILE && job.state.kind === 'pending')
		.map((job) => ({
			fileId: (job.args[0] as { fileId: string }).fileId,
			delayMs: job.scheduledTime - Date.now(),
		}));
}

const saveProvider = (t: T) =>
	t.mutation(internal.aiProviderConfig._persistConfig, {
		languageProviderKind: 'openai',
		modelFast: 'fast',
		modelCapable: 'capable',
		isLanguageLocal: false,
		languageEnvelope: { ...encryptSecret('sk-language-key'), keyPreview: 'sk-…-key' },
		embeddingProviderKind: 'local',
		isEmbeddingLocal: true,
	});

beforeEach(() => {
	vi.useFakeTimers();
	for (const key of LLM_ENV_KEYS) vi.stubEnv(key, undefined);
	vi.stubEnv('INSTANCE_SECRET', 'test-instance-secret-value-for-aes-256-gcm-kdf');
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe('backfillUnprocessed', () => {
	it('schedules nothing while no AI provider is set up', async () => {
		const t = newHarness();
		await insertFile(t);

		expect(await t.mutation(internal.semanticFiles.backfillUnprocessed, {})).toEqual({
			scheduled: 0,
		});
		expect(await processJobs(t)).toEqual([]);
	});

	it('reschedules a recent file without an embedding once a provider is set up', async () => {
		vi.stubEnv('LLM_API_KEY', 'sk-test');
		const t = newHarness();
		const fileId = await insertFile(t);
		await insertFile(t, { embedded: true });

		expect(await t.mutation(internal.semanticFiles.backfillUnprocessed, {})).toEqual({
			scheduled: 1,
		});
		expect(await processJobs(t)).toEqual([{ fileId, delayMs: 0 }]);
	});

	it('counts a provider saved through Settings → AI', async () => {
		const t = newHarness();
		await saveProvider(t);
		await insertFile(t);

		expect(await t.mutation(internal.semanticFiles.backfillUnprocessed, {})).toEqual({
			scheduled: 1,
		});
	});
});

describe('saving the first AI provider', () => {
	it('reprocesses, once and spaced out, the files processed without one', async () => {
		const t = newHarness();
		// Older than the backfill's two-hour window: nothing else would reach it.
		const old = await insertFile(t, { ageMs: 30 * 24 * 60 * 60 * 1000 });
		await insertFile(t, { embedded: true });
		await insertFile(t, { released: true });
		const recent = await insertFile(t);

		await saveProvider(t);
		const pass = (await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect()))
			.filter((job) => job.name === 'semanticFiles:reprocessAfterAiConfigured')
			.map((job) => job.scheduledTime - Date.now());
		expect(pass).toEqual([0]);

		expect(await t.mutation(internal.semanticFiles.reprocessAfterAiConfigured, {})).toEqual({
			scheduled: 2,
		});
		expect(await processJobs(t)).toEqual([
			{ fileId: recent, delayMs: 0 },
			{ fileId: old, delayMs: 2_000 },
		]);
	});

	it('does not schedule the pass again when the provider is changed', async () => {
		const t = newHarness();
		await saveProvider(t);
		await saveProvider(t);

		const passes = (
			await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
		).filter((job) => job.name === 'semanticFiles:reprocessAfterAiConfigured');
		expect(passes).toHaveLength(1);
	});

	it('does not schedule it when the environment already provided one', async () => {
		vi.stubEnv('LLM_API_KEY', 'sk-test');
		const t = newHarness();
		await saveProvider(t);

		const passes = (
			await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
		).filter((job) => job.name === 'semanticFiles:reprocessAfterAiConfigured');
		expect(passes).toEqual([]);
	});
});
