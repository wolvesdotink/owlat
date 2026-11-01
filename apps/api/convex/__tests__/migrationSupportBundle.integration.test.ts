/**
 * `migrations/admin:supportBundleState`, the ledger read behind
 * `owlat support-bundle`: every manifest migration with its state, counts and
 * timestamps, and the runner, but none of the text the ledger holds (error
 * messages can quote a document), no cursor and no auth user id. The bundle
 * leaves the operator's box, so what is absent matters as much as what is
 * there.
 */
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { MIGRATION_MANIFEST } from '../migrations/manifest';

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/index') &&
			!path.includes('agent/steps/shared') &&
			!path.includes('agent/steps/classify') &&
			!path.includes('agent/steps/draft') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('files/processing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

const PRIVATE = ['marcel@example.com', 'cursor-secret', 'admin-user'];

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('supportBundleState', () => {
	it('lists every manifest migration as pending on a fresh deployment, with no runner', async () => {
		const t = convexTest(schema, modules);
		const state = await t.query(internal.migrations.admin.supportBundleState, {});
		expect(state.deployedVersion).toBeNull();
		expect(state.runner).toBeNull();
		expect(state.migrations.map((m) => m.migration)).toEqual(
			MIGRATION_MANIFEST.map((entry) => entry.migration)
		);
		expect(state.migrations.every((m) => m.state === 'pending' && m.startedAt === null)).toBe(true);
	});

	it('reports states, counts and whether there is an error, never the error text', async () => {
		vi.stubEnv('OWLAT_VERSION', '0.6.16');
		const t = convexTest(schema, modules);
		const [failing, done] = MIGRATION_MANIFEST.map((entry) => entry.migration);
		await t.run(async (ctx) => {
			await ctx.db.insert('migrationRuns', {
				migration: failing!,
				introducedIn: '0.6.0',
				status: 'running',
				generation: 2,
				cursor: 'cursor-secret',
				pageCount: 3,
				scannedCount: 300,
				changedCount: 12,
				startedAt: 1_000,
				updatedAt: 2_000,
				failure: { error: 'Document of marcel@example.com is invalid', at: 2_000 },
			});
			await ctx.db.insert('migrationRuns', {
				migration: done!,
				introducedIn: '0.6.0',
				status: 'completed',
				generation: 1,
				pageCount: 1,
				scannedCount: 10,
				changedCount: 0,
				startedAt: 1_000,
				updatedAt: 1_500,
				completedAt: 1_500,
			});
			await ctx.db.insert('migrationDriver', {
				status: 'stopped',
				generation: 4,
				startedBy: 'admin-user',
				startedAt: 900,
				updatedAt: 2_100,
				finishedAt: 2_100,
				stoppedMigration: failing!,
				stoppedError: 'Document of marcel@example.com is invalid',
			});
		});

		const state = await t.query(internal.migrations.admin.supportBundleState, {});
		expect(state.deployedVersion).toBe('0.6.16');
		expect(state.migrations.find((m) => m.migration === failing)).toMatchObject({
			state: 'failed',
			hasError: true,
			pageCount: 3,
			scannedCount: 300,
			changedCount: 12,
			startedAt: 1_000,
			updatedAt: 2_000,
			completedAt: null,
		});
		expect(state.migrations.find((m) => m.migration === done)).toMatchObject({
			state: 'completed',
			hasError: false,
			completedAt: 1_500,
		});
		expect(state.runner).toEqual({
			status: 'stopped',
			startedAt: 900,
			updatedAt: 2_100,
			finishedAt: 2_100,
			stoppedMigration: failing,
			hasStoppedError: true,
		});
		const text = JSON.stringify(state);
		for (const needle of PRIVATE) expect(text).not.toContain(needle);
	});
});
