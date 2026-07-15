import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../_generated/server';
import schema from '../../schema';
import { bindAuthenticatedBundledPluginLlm, PluginLlmError } from '../llm';
import { resolveLanguageModel } from '../../lib/llmProvider';
import { runLlmTextWithAttemptMetadata } from '../../lib/llm/dispatch';

const rootGlob = import.meta.glob('../../**/*.*s');
const pluginGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../plugins/'),
		module,
	])
);
const modules = { ...rootGlob, ...pluginGlob };
const auth = vi.hoisted(() => ({ organizationId: 'tenant', isMember: true }));
const registry = vi.hoisted(() => ({
	plugins: [
		{
			packageName: 'test-alpha',
			manifest: {
				id: 'alpha',
				version: '1.0.0',
				capabilities: ['llm:invoke'],
				flag: { default: false },
				llmBudget: { dailyUsd: 1 },
			},
		},
	],
}));

vi.mock('../../lib/sessionOrganization', async () => ({
	...(await vi.importActual('../../lib/sessionOrganization')),
	getBetterAuthSessionWithRole: vi.fn(async () =>
		auth.isMember
			? { activeOrganizationId: auth.organizationId, userId: 'actor', role: 'owner' }
			: null
	),
}));
vi.mock('../plugins.generated', () => ({ bundledPluginComposition: registry.plugins }));
vi.mock('../../lib/llmProvider', () => ({ resolveLanguageModel: vi.fn() }));
vi.mock('../../lib/llm/dispatch', async () => ({
	...(await vi.importActual('../../lib/llm/dispatch')),
	runLlmTextWithAttemptMetadata: vi.fn(),
}));

beforeEach(() => {
	auth.organizationId = 'tenant';
	auth.isMember = true;
	registry.plugins[0]!.manifest.capabilities = ['llm:invoke'];
	vi.mocked(resolveLanguageModel)
		.mockReset()
		.mockResolvedValue('gpt-4o-mini' as never);
	vi.mocked(runLlmTextWithAttemptMetadata)
		.mockReset()
		.mockResolvedValue({
			attempts: 1,
			result: {
				text: 'safe result',
				modelUsed: 'gpt-4o-mini',
				tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			},
		});
});

async function setup() {
	const t = convexTest(schema, modules);
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			featureFlags: { 'plugin.alpha': true },
			pluginCapabilityGrants: { 'plugin.alpha': { 'llm:invoke': true } },
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
	const actionCtx = {
		runQuery: t.query as unknown as ActionCtx['runQuery'],
		runMutation: t.mutation as unknown as ActionCtx['runMutation'],
	} as unknown as ActionCtx;
	return { t, service: bindAuthenticatedBundledPluginLlm(actionCtx, 'alpha') };
}

describe('hosted plugin LLM service', () => {
	it('routes bounded requests through dispatch and returns normalized attribution', async () => {
		const { t, service } = await setup();
		const result = await service.generate({ tier: 'fast', prompt: 'hello' });
		expect(result).toEqual({
			text: 'safe result',
			modelUsed: 'gpt-4o-mini',
			usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
		});
		expect(resolveLanguageModel).toHaveBeenCalledWith(expect.anything(), 'summarize');
		expect(runLlmTextWithAttemptMetadata).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: 'hello', maxOutputTokens: 2048 })
		);
		await t.run(async (ctx) => {
			expect(await ctx.db.query('pluginLlmReservations').unique()).toMatchObject({
				pluginId: 'alpha',
				status: 'completed',
				tier: 'fast',
			});
			expect(await ctx.db.query('llmUsageEvents').unique()).toMatchObject({ pluginId: 'alpha' });
		});
	});

	it('authorizes before resolving tenant provider configuration and rechecks at reserve', async () => {
		const { t, service } = await setup();
		await t.run(async (ctx) => {
			const settings = await ctx.db.query('instanceSettings').unique();
			await ctx.db.patch(settings!._id, {
				pluginCapabilityGrants: { 'plugin.alpha': { 'llm:invoke': false } },
			});
		});
		await expect(service.generate({ tier: 'capable', prompt: 'secret' })).rejects.toMatchObject({
			code: 'access_denied',
		});
		expect(resolveLanguageModel).not.toHaveBeenCalled();
		expect(runLlmTextWithAttemptMetadata).not.toHaveBeenCalled();
	});

	it('denies a grant revoked after preflight but before the reservation transaction', async () => {
		const { t, service } = await setup();
		vi.mocked(resolveLanguageModel).mockImplementationOnce(async () => {
			await t.run(async (ctx) => {
				const settings = await ctx.db.query('instanceSettings').unique();
				await ctx.db.patch(settings!._id, {
					pluginCapabilityGrants: { 'plugin.alpha': { 'llm:invoke': false } },
				});
			});
			return 'gpt-4o-mini' as never;
		});
		await expect(service.generate({ tier: 'fast', prompt: 'safe' })).rejects.toMatchObject({
			code: 'access_denied',
		});
		expect(resolveLanguageModel).toHaveBeenCalledTimes(1);
		expect(runLlmTextWithAttemptMetadata).not.toHaveBeenCalled();
		await t.run(async (ctx) => {
			expect(await ctx.db.query('pluginLlmReservations').take(1)).toEqual([]);
		});
	});

	it('retains the full reservation on ambiguous provider failure without logging the error', async () => {
		const { t, service } = await setup();
		vi.mocked(runLlmTextWithAttemptMetadata).mockRejectedValueOnce(
			new Error('provider leaked TOP_SECRET')
		);
		const error = await service
			.generate({ tier: 'capable', prompt: 'PROMPT_SECRET' })
			.catch((cause) => cause);
		expect(error).toBeInstanceOf(PluginLlmError);
		expect(error).toMatchObject({ code: 'provider_failure' });
		expect(error.message).not.toContain('SECRET');
		await t.run(async (ctx) => {
			const reservation = await ctx.db.query('pluginLlmReservations').unique();
			const daily = await ctx.db.query('pluginLlmDailyUsage').unique();
			expect(reservation).toMatchObject({ status: 'failed' });
			expect(daily?.chargedMicrousd).toBe(reservation?.reservedMicrousd);
			expect(JSON.stringify(await ctx.db.query('auditLogs').take(5))).not.toContain('SECRET');
		});
	});

	it('fails closed before dispatch when the resolved model has no known price', async () => {
		const { service } = await setup();
		vi.mocked(resolveLanguageModel).mockResolvedValueOnce('private-unpriced-model' as never);
		await expect(service.generate({ tier: 'fast', prompt: 'hello' })).rejects.toMatchObject({
			code: 'access_denied',
		});
		expect(runLlmTextWithAttemptMetadata).not.toHaveBeenCalled();
	});
});
