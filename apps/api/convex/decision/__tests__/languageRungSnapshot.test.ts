/**
 * The language rung dispatches through the configuration the rung was decided
 * on (final review r4 F1). The language resolver keeps the config row for 30
 * seconds per isolate, so a save in another isolate leaves a warm cache naming
 * the replaced provider and model. A bundle reads the language plane fresh,
 * refuses (`stale`) when its version is not the routing read's, and stamps the
 * claim with the version of the snapshot it dispatches with.
 *
 * The real language resolver and its cache run here; only the model dispatch
 * and the admission seam are mocked.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import type { ActionCtx } from '../../_generated/server';
import {
	createTestContact,
	createTestInboundMessage,
	enableFeatures,
} from '../../__tests__/factories';

const mocks = vi.hoisted(() => ({
	runLlmObject: vi.fn(),
	admitBundle: vi.fn(),
}));

vi.mock('../../lib/llm/dispatch', async () => {
	const { metered } = await import('../../analytics/__tests__/meteredDispatch.testlib');
	return {
		...(await vi.importActual<object>('../../lib/llm/dispatch')),
		runLlmObject: metered((opts: unknown) => mocks.runLlmObject(opts)),
	};
});
vi.mock('../bundleAdmission', async () => ({
	...(await vi.importActual<object>('../bundleAdmission')),
	admitBundle: mocks.admitBundle,
}));

import { runBundle } from '../bundleRunner';
import { NECESSITY_BUNDLE } from '../../lib/decision/bundles';
import { necessityState } from '../../lib/decision/necessityState';
import type { RoutingContext } from '../context';
import {
	__resetAiConfigCacheForTests,
	resolveLanguageModelWithProvenance,
} from '../../lib/llmProvider';

// The decision directory's own modules, keyed the way convex-test looks them up.
const decisionGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../decision/'),
		mod,
	])
);
const modules = Object.fromEntries(
	Object.entries({ ...import.meta.glob('../../**/*.*s'), ...decisionGlob }).filter(
		([path]) => !path.includes('knowledgeExtraction')
	)
);

type T = ReturnType<typeof convexTest>;

function actionCtx(t: T): ActionCtx {
	const run = t as unknown as Record<
		'query' | 'mutation' | 'action',
		(ref: unknown, args: unknown) => Promise<unknown>
	>;
	return {
		runQuery: (ref: unknown, args: unknown) => run.query(ref, args),
		runMutation: (ref: unknown, args: unknown) => run.mutation(ref, args),
		runAction: (ref: unknown, args: unknown) => run.action(ref, args),
	} as unknown as ActionCtx;
}

/** A keyless local language provider, so nothing is decrypted. */
const LOCAL_LANGUAGE = {
	languageProviderKind: 'openaiCompatible' as const,
	languageBaseUrl: 'http://localhost:11434/v1',
	modelCapable: 'local-capable',
	embeddingProviderKind: 'local' as const,
	embeddingModelVersion: 1,
};

async function setup(): Promise<{
	t: T;
	configId: Id<'aiProviderConfig'>;
	id: Id<'inboundMessages'>;
}> {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	await enableFeatures(t, ['ai.agent', 'ai']);
	const configId = await t.run(async (ctx) => {
		await ctx.db.insert('aiRoutingPolicy', {
			clarifyNecessity: 'enforce',
			shadowCapUsd: 1,
			policyVersion: 4,
			updatedAt: Date.now(),
			updatedBy: 'admin-1',
		});
		return ctx.db.insert('aiProviderConfig', {
			...LOCAL_LANGUAGE,
			modelFast: 'model-a',
			configRevision: 1,
			updatedAt: 1_000,
		});
	});
	const id = await t.run(async (ctx) => {
		const contactId = await ctx.db.insert(
			'contacts',
			createTestContact({ email: 'ada@example.com' })
		);
		const threadId = await ctx.db.insert('conversationThreads', {
			subject: 'New date',
			normalizedSubject: 'new date',
			contactId,
			contactIdentifier: 'ada@example.com',
			status: 'open',
			messageCount: 1,
			lastMessageAt: Date.now(),
			firstMessageAt: Date.now(),
			createdAt: Date.now(),
		});
		return ctx.db.insert(
			'inboundMessages',
			createTestInboundMessage({
				from: 'Ada <ada@example.com>',
				subject: 'New date',
				textBody: 'Can we move the launch, and at what price?',
				contactId,
				threadId,
			})
		);
	});
	return { t, configId, id };
}

/** Another isolate's save: a new model, the revision moved, `updatedAt` kept. */
async function saveElsewhere(t: T, configId: Id<'aiProviderConfig'>) {
	await t.run((ctx) => ctx.db.patch(configId, { modelFast: 'model-b', configRevision: 2 }));
}

function necessityRun(t: T, routed: RoutingContext, id: Id<'inboundMessages'>) {
	return runBundle(actionCtx(t), {
		bundle: NECESSITY_BUNDLE,
		plan: { task: 'mail.necessity', mode: 'advisory' },
		routing: routed,
		subject: { kind: 'inbound_message', inboundMessageId: id },
		built: necessityState('Customer: can we move the launch, and at what price?'),
		root: { rootRequestId: `team:${id}` },
	});
}

const dispatchedModels = () =>
	mocks.runLlmObject.mock.calls.map(
		([opts]) => (opts as { model: { modelId: string } }).model.modelId
	);

beforeEach(() => {
	__resetAiConfigCacheForTests();
	mocks.admitBundle.mockResolvedValue({
		isAdmitted: true,
		target: { feature: 'decision_necessity', task: 'mail.necessity' },
		decision: { recordUsage: vi.fn() },
	});
	mocks.runLlmObject.mockResolvedValue({
		object: { necessity: 0.9 },
		tokenUsage: { promptTokens: 200, completionTokens: 2, totalTokens: 202 },
		modelUsed: 'model-b',
	});
});
afterEach(() => {
	vi.clearAllMocks();
	__resetAiConfigCacheForTests();
});

describe('the language rung under a warm language cache (final r4 F1)', () => {
	it('dispatches the saved model, stamped with its own version, not the cached one', async () => {
		const { t, configId, id } = await setup();
		// This isolate resolves revision 1 and keeps it for 30 seconds.
		const warm = await resolveLanguageModelWithProvenance(actionCtx(t), 'mail.necessity');
		expect(warm.configVersion).toBe(`${configId}:1`);
		await saveElsewhere(t, configId);
		const cached = await resolveLanguageModelWithProvenance(actionCtx(t), 'mail.necessity');
		expect(cached.modelId).toBe('model-a'); // the warm cache still names the old model

		const routed = await t.query(internal.decision.context.routingContext, {});
		expect(routed.configVersion).toBe(`${configId}:2`);
		const outcome = await necessityRun(t, routed, id);

		expect(outcome).toMatchObject({ hasRun: true, status: 'complete' });
		expect(dispatchedModels()).toEqual(['model-b']);
		const [artifact] = await t.run((ctx) => ctx.db.query('decisionArtifacts').collect());
		expect(artifact?.contextVersion).toContain('|model-b|');
	});

	it('refuses as stale when the configuration moved after the routing read', async () => {
		const { t, configId, id } = await setup();
		const routed = await t.query(internal.decision.context.routingContext, {});
		await saveElsewhere(t, configId);

		expect(await necessityRun(t, routed, id)).toEqual({ hasRun: false, why: 'stale' });
		// Refused at resolution, as the decision rung refuses: no admission, no call.
		expect(mocks.admitBundle).not.toHaveBeenCalled();
		expect(mocks.runLlmObject).not.toHaveBeenCalled();
		expect(await t.run((ctx) => ctx.db.query('decisionArtifacts').collect())).toEqual([]);
	});
});
