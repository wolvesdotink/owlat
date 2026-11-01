/**
 * The previous release's LLM-backed action paths (`translate:translateBatch`,
 * `quickQuery:ask`, `visualizationAgentActions:generate`) run this release's
 * code: each returns or writes what its moved function does for the same
 * input, and keeps its gates. The model calls are mocked; the gates, the
 * retrieval seams and the commits are real.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { storedEmbeddingTarget } from '../lib/embeddingSpace';
import type * as LlmDispatchModule from '../lib/llm/dispatch';
import type * as LlmProviderModule from '../lib/llmProvider';
import { enableFeatures } from './factories';

const session = vi.hoisted(() => ({ member: true }));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	const member = async () => {
		if (!session.member) {
			throw Object.assign(new Error('You do not have access to this organization'), {
				data: { category: 'forbidden' },
			});
		}
		return { userId: 'user-1', role: 'owner' as const, activeOrganizationId: 'org-1' };
	};
	return {
		...actual,
		requireOrgMember: vi.fn(member),
		getMutationContext: vi.fn(member),
		requireOrgPermission: vi.fn(member),
		requireAdminContext: vi.fn(member),
		isActiveOrgMember: vi.fn(async () => session.member),
		getUserIdFromSession: vi.fn(async () => 'user-1'),
		requireAuthenticatedIdentity: vi.fn(async () => ({ subject: 'user-1' })),
		getBetterAuthSessionWithRole: vi.fn(member),
	};
});

// No real model: the resolvers hand back a name, and the dispatch seam answers.
vi.mock('../lib/llmProvider', async () => {
	const actual = await vi.importActual<typeof LlmProviderModule>('../lib/llmProvider');
	return {
		...actual,
		resolveLanguageModel: vi.fn(async () => 'test-model'),
		resolveIndexEmbedder: vi.fn(async () => ({
			model: 'test-embedding-model',
			target: storedEmbeddingTarget({ embeddingProviderKind: 'openai' }),
		})),
	};
});

const llm = vi.hoisted(() => ({ runLlmText: vi.fn(), runLlmObject: vi.fn() }));
vi.mock('../lib/llm/dispatch', async () => {
	const actual = await vi.importActual<typeof LlmDispatchModule>('../lib/llm/dispatch');
	return { ...actual, runLlmText: llm.runLlmText, runLlmObject: llm.runLlmObject };
});

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
			!path.includes('knowledgeExtraction')
	)
);

type T = ReturnType<typeof convexTest>;

function setup() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

const text = (value: string) => ({ text: value, tokenUsage: undefined, modelUsed: 'test-model' });

beforeEach(() => {
	session.member = true;
	llm.runLlmText.mockReset();
	llm.runLlmObject.mockReset();
});

describe('previous-release translate path', () => {
	const args = {
		items: [
			{ id: 'subject', text: 'Hello', isHtml: false },
			{ id: 'body', text: '<p>Thanks</p>', isHtml: true },
		],
		sourceLanguage: 'English',
		targetLanguage: 'German',
	};

	it('translate:translateBatch returns what emailTemplates/translate returns', async () => {
		const t = setup();
		await enableFeatures(t, ['ai']);
		llm.runLlmObject.mockResolvedValue({
			object: {
				translations: [
					{ index: 1, translatedText: '<p>Danke</p>' },
					{ index: 0, translatedText: 'Hallo' },
				],
			},
			tokenUsage: undefined,
			modelUsed: 'test-model',
		});

		const viaOld = await t.action(api.translate.translateBatch, args);
		expect(viaOld).toEqual(await t.action(api.emailTemplates.translate.translateBatch, args));
		expect(viaOld.translations).toEqual([
			{ id: 'body', translatedText: '<p>Danke</p>' },
			{ id: 'subject', translatedText: 'Hallo' },
		]);
	});

	it('keeps the input caps and the AI gate on the old path', async () => {
		const t = setup();
		await expect(t.action(api.translate.translateBatch, args)).rejects.toThrow(/disabled/i);
		await enableFeatures(t, ['ai']);
		await expect(
			t.action(api.translate.translateBatch, {
				...args,
				items: Array.from({ length: 51 }, (_, i) => ({ id: `${i}`, text: 'x', isHtml: false })),
			})
		).rejects.toThrow(/too many items/i);
		expect(llm.runLlmObject).not.toHaveBeenCalled();
	});
});

describe('previous-release Quick Query path', () => {
	it('quickQuery:ask answers as assistant/quickQuery does', async () => {
		const t = setup();
		await enableFeatures(t, ['ai.knowledge']);
		// Nothing to retrieve: both paths answer without a model call.
		const viaOld = await t.action(api.quickQuery.ask, { question: 'What is our refund policy?' });
		expect(viaOld).toEqual(
			await t.action(api.assistant.quickQuery.ask, { question: 'What is our refund policy?' })
		);
		expect(viaOld).toMatchObject({ sources: [], isTruncated: false });
		expect(viaOld.answer).toMatch(/couldn't find/);
		expect(await t.action(api.quickQuery.ask, { question: '   ' })).toEqual({
			answer: 'Please enter a question.',
			sources: [],
			isTruncated: false,
		});
	});

	it('keeps the knowledge gates on the old path', async () => {
		const t = setup();
		await expect(t.action(api.quickQuery.ask, { question: 'budget' })).rejects.toThrow(
			/disabled|forbidden/i
		);
		await enableFeatures(t, ['ai.knowledge']);
		session.member = false;
		await expect(t.action(api.quickQuery.ask, { question: 'budget' })).rejects.toThrow(
			/access|forbidden/i
		);
		expect(llm.runLlmText).not.toHaveBeenCalled();
	});
});

describe('previous-release visualization generation path', () => {
	async function seedVisualization(t: T): Promise<Id<'visualizations'>> {
		return await t.run((ctx) =>
			ctx.db.insert('visualizations', {
				title: 'Open rates by week',
				description: 'Open rates by week',
				html: '<p>Generating</p>',
				pinned: false,
				createdBy: 'user-1',
				createdAt: 1_000,
				updatedAt: 1_000,
			})
		);
	}

	/** One generation: the page, then the title. */
	function answerOnce() {
		llm.runLlmText
			.mockResolvedValueOnce(text('```html\n<!DOCTYPE html><html><body>chart</body></html>\n```'))
			.mockResolvedValueOnce(text('  Weekly open rates  '));
	}

	it('a job queued as visualizationAgentActions:generate writes what the moved action writes', async () => {
		const t = setup();
		const viaOld = await seedVisualization(t);
		const viaNew = await seedVisualization(t);

		answerOnce();
		await t.action(internal.visualizationAgentActions.generate, {
			visualizationId: viaOld,
			prompt: 'Open rates by week',
		});
		answerOnce();
		await t.action(internal.analytics.visualizationAgentActions.generate, {
			visualizationId: viaNew,
			prompt: 'Open rates by week',
		});

		const [oldRow, newRow] = await t.run(async (ctx) => [
			await ctx.db.get(viaOld),
			await ctx.db.get(viaNew),
		]);
		const page = (row: typeof oldRow) => ({
			title: row?.title,
			html: row?.html,
			dataQuery: row?.dataQuery,
			budgetRefusal: row?.budgetRefusal,
		});
		expect(page(oldRow)).toEqual(page(newRow));
		expect(page(oldRow)).toEqual({
			title: 'Weekly open rates',
			html: '<!DOCTYPE html><html><body>chart</body></html>',
			dataQuery: undefined,
			budgetRefusal: undefined,
		});
	});

	it('stores the failure page through the old path when the model fails', async () => {
		const t = setup();
		const id = await seedVisualization(t);
		llm.runLlmText.mockRejectedValueOnce(new Error('model unavailable'));

		await t.action(internal.visualizationAgentActions.generate, {
			visualizationId: id,
			prompt: 'Open rates by week',
		});

		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row?.title).toBe('Error');
		expect(row?.html).toContain('model unavailable');
	});
});
