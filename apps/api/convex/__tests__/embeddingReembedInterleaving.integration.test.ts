/**
 * `startReembed` against a configuration that moves while it runs (ADR-0073;
 * Sol's review of the expected-target guard). The configuration is read once:
 * the target checked against the confirmation is the one whose credential and
 * endpoint the bootstrap call uses, and its activation is refused in its own
 * transaction when the configuration no longer names the confirmed target.
 *
 * Hooks switch the configuration at exact points: right after the snapshot
 * read, and during the bootstrap embedding call.
 */
import { convexTest } from 'convex-test';
import { ConvexError, type Value } from 'convex/values';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Ai from 'ai';
import type * as LlmProvider from '../lib/llmProvider';
import schema from '../schema';
import { api } from '../_generated/api';
import { EMBEDDING_TARGET_CHANGED } from '../lib/aiRouting/embeddingRegistry';
import { configureLocalEmbedder } from './helpers/embeddingSpaces';

const hooks = vi.hoisted(() => ({
	afterSnapshot: undefined as (() => Promise<void>) | undefined,
	onEmbed: undefined as (() => Promise<void>) | undefined,
	embeddedModels: [] as string[],
}));

vi.mock('ai', async () => {
	const actual = await vi.importActual<typeof Ai>('ai');
	return {
		...actual,
		embed: vi.fn(async ({ model }: { model: { modelId: string } }) => {
			hooks.embeddedModels.push(model.modelId);
			await hooks.onEmbed?.();
			return {
				embedding: Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0)),
				usage: { tokens: 1 },
			};
		}),
	};
});

vi.mock('../lib/llmProvider', async () => {
	const actual = await vi.importActual<typeof LlmProvider>('../lib/llmProvider');
	return {
		...actual,
		readEmbeddingConfigSnapshot: vi.fn(
			async (ctx: Parameters<typeof actual.readEmbeddingConfigSnapshot>[0]) => {
				const snapshot = await actual.readEmbeddingConfigSnapshot(ctx);
				await hooks.afterSnapshot?.();
				return snapshot;
			}
		),
	};
});

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<object>('../lib/sessionOrganization');
	const admin = async () => ({ userId: 'admin-1', role: 'owner', activeOrganizationId: 'org-1' });
	return {
		...actual,
		requireOrgPermission: vi.fn(admin),
		requireAdminContext: vi.fn(admin),
		requireOrgMember: vi.fn(admin),
	};
});

const modules = import.meta.glob('../**/*.*s');
type T = ReturnType<typeof convexTest>;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	hooks.afterSnapshot = undefined;
	hooks.onEmbed = undefined;
	hooks.embeddedModels = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response('not found', { status: 404 }))
	);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const flush = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

/** A pending switch to the local default (no space yet), and the key an admin confirms. */
async function pendingSwitch(t: T): Promise<string> {
	await configureLocalEmbedder(t);
	return (await t.query(api.aiRouting.embeddingSpaces.status, {})).configured!.targetKey;
}

/** Another admin selects another model, once. */
function switchOnce(t: T): () => Promise<void> {
	let isDone = false;
	return async () => {
		if (isDone) return;
		isDone = true;
		await configureLocalEmbedder(t, 'all-minilm');
	};
}

async function rejection(call: Promise<unknown>): Promise<Record<string, unknown>> {
	const error = await call.then(
		() => null,
		(caught: unknown) => caught
	);
	expect(error).toBeInstanceOf(ConvexError);
	return (error as ConvexError<Value>).data as Record<string, unknown>;
}

const nothingStarted = async (t: T) => {
	await flush(t);
	expect(await t.run((ctx) => ctx.db.query('embeddingSpaces').collect())).toEqual([]);
	expect(await t.run((ctx) => ctx.db.query('embeddingReembedJobs').collect())).toEqual([]);
};

describe('startReembed while the configuration moves', () => {
	it('embeds only the confirmed target when the switch lands right after its one read (F1)', async () => {
		const t = convexTest(schema, modules);
		const confirmed = await pendingSwitch(t);
		hooks.afterSnapshot = switchOnce(t);

		const error = await rejection(
			t.action(api.aiRouting.embeddingReembed.startReembed, { expectedTargetKey: confirmed })
		);
		expect(error).toMatchObject({
			category: 'conflict',
			data: { reason: EMBEDDING_TARGET_CHANGED },
		});
		// The bootstrap used the snapshot's target, never the switched-to model,
		// and its activation was refused: no space, no kickoff, no job.
		expect(hooks.embeddedModels).toEqual(['nomic-embed-text']);
		await nothingStarted(t);
	});

	it('refuses a switch during the bootstrap call as embedding_target_changed (F2)', async () => {
		const t = convexTest(schema, modules);
		const confirmed = await pendingSwitch(t);
		hooks.onEmbed = switchOnce(t);

		const error = await rejection(
			t.action(api.aiRouting.embeddingReembed.startReembed, { expectedTargetKey: confirmed })
		);
		expect(error).toMatchObject({
			category: 'conflict',
			data: { reason: EMBEDDING_TARGET_CHANGED },
		});
		await nothingStarted(t);
	});

	it('keeps the configuration-changed refusal when no key was confirmed', async () => {
		const t = convexTest(schema, modules);
		await pendingSwitch(t);
		hooks.onEmbed = switchOnce(t);

		const error = await rejection(t.action(api.aiRouting.embeddingReembed.startReembed, {}));
		expect(error).toMatchObject({ category: 'invalid_state' });
		await nothingStarted(t);
	});

	it('bootstraps and starts the job when nothing moves', async () => {
		const t = convexTest(schema, modules);
		const confirmed = await pendingSwitch(t);
		const jobId = await t.action(api.aiRouting.embeddingReembed.startReembed, {
			expectedTargetKey: confirmed,
		});
		expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({ status: 'running' });
	});
});
