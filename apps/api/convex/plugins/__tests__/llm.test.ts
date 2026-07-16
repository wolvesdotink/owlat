import { convexTest } from 'convex-test';
import { MockLanguageModelV3 } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../_generated/server';
import schema from '../../schema';
import {
	bindAuthenticatedBundledPluginLlm,
	bindSystemBundledPluginLlm,
	PluginLlmError,
} from '../llm';
import { resolveLanguageModelWithProvenance } from '../../lib/llmProvider';
import { providerGenerationResult } from '../../lib/llm/__tests__/providerModel.testlib';

const rootGlob = import.meta.glob('../../**/*.*s');
const pluginGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../plugins/'),
		module,
	])
);
const modules = { ...rootGlob, ...pluginGlob };
const auth = vi.hoisted(() => ({ organizationId: 'tenant', isMember: true }));
const providerGenerate = vi.fn();
const registry = vi.hoisted(() => ({
	plugins: [
		{
			packageName: 'test-alpha',
			manifest: {
				id: 'alpha',
				version: '1.0.0',
				capabilities: ['llm:invoke'],
				flag: { default: false, requiredEnvVars: [] as string[] },
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
	getSingletonOrganizationId: vi.fn(async () => auth.organizationId),
}));
vi.mock('../plugins.generated', () => ({ bundledPluginComposition: registry.plugins }));
vi.mock('../../lib/llmProvider', () => ({ resolveLanguageModelWithProvenance: vi.fn() }));

beforeEach(() => {
	delete process.env['PP09_REQUIRED_KEY_NOT_PRESENT'];
	auth.organizationId = 'tenant';
	auth.isMember = true;
	registry.plugins[0]!.manifest.capabilities = ['llm:invoke'];
	registry.plugins[0]!.manifest.flag.requiredEnvVars = [];
	registry.plugins[0]!.manifest.llmBudget.dailyUsd = 1;
	vi.mocked(resolveLanguageModelWithProvenance)
		.mockReset()
		.mockResolvedValue({
			model: new MockLanguageModelV3({
				modelId: 'gpt-4o-mini',
				doGenerate: providerGenerate,
			}),
			modelId: 'gpt-4o-mini',
			endpointProvenance: 'openai-native',
		});
	providerGenerate
		.mockReset()
		.mockResolvedValue(providerGenerationResult({ modelId: 'gpt-4o-mini' }, 'safe result'));
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
	return { t, actionCtx, service: bindAuthenticatedBundledPluginLlm(actionCtx, 'alpha') };
}

describe('hosted plugin LLM service', () => {
	it('supports background strategy dispatch with system attribution and the same budget gate', async () => {
		const { t, actionCtx } = await setup();
		const result = await bindSystemBundledPluginLlm(actionCtx, 'alpha').generate({
			tier: 'fast',
			prompt: 'safe bounded strategy input',
		});
		expect(result.text).toBe('safe result');
		await t.run(async (ctx) => {
			expect(await ctx.db.query('pluginLlmReservations').unique()).toMatchObject({
				actorUserId: 'system:bundled_plugin',
				status: 'completed',
			});
			expect(
				await ctx.db
					.query('auditLogs')
					.filter((q) => q.eq(q.field('pluginId'), 'alpha'))
					.take(5)
			).toEqual(
				expect.arrayContaining([expect.objectContaining({ userId: 'system:bundled_plugin' })])
			);
		});
	});

	it('denies background dispatch when its execution lease is already revoked', async () => {
		const { t, actionCtx } = await setup();
		const controller = new AbortController();
		controller.abort();
		await expect(
			bindSystemBundledPluginLlm(actionCtx, 'alpha', controller.signal).generate({
				tier: 'fast',
				prompt: 'must not spend after timeout',
			})
		).rejects.toMatchObject({ code: 'access_denied' });
		expect(resolveLanguageModelWithProvenance).not.toHaveBeenCalled();
		expect(providerGenerate).not.toHaveBeenCalled();
		await t.run(async (ctx) => {
			expect(await ctx.db.query('pluginLlmReservations').take(1)).toEqual([]);
			expect(await ctx.db.query('pluginLlmDailyUsage').take(1)).toEqual([]);
		});
	});

	it('aborts an admitted provider call when the host revokes its execution lease', async () => {
		const { t, actionCtx } = await setup();
		const controller = new AbortController();
		providerGenerate.mockImplementationOnce(
			async (options) =>
				new Promise((_resolve, reject) => {
					expect(options.abortSignal).toBe(controller.signal);
					options.abortSignal?.addEventListener(
						'abort',
						() => reject(new Error('provider request aborted')),
						{ once: true }
					);
				})
		);
		const pending = bindSystemBundledPluginLlm(actionCtx, 'alpha', controller.signal).generate({
			tier: 'fast',
			prompt: 'bounded request',
		});
		await vi.waitFor(() => expect(providerGenerate).toHaveBeenCalledTimes(1));
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: 'access_denied' });
		await t.run(async (ctx) => {
			expect(await ctx.db.query('pluginLlmReservations').unique()).toMatchObject({
				status: 'failed',
				actorUserId: 'system:bundled_plugin',
			});
			expect(await ctx.db.query('llmUsageEvents').take(1)).toEqual([]);
		});
	});

	it('denies background dispatch when the operator grant is disabled', async () => {
		const { t, actionCtx } = await setup();
		await t.run(async (ctx) => {
			const settings = await ctx.db.query('instanceSettings').unique();
			await ctx.db.patch(settings!._id, {
				pluginCapabilityGrants: { 'plugin.alpha': { 'llm:invoke': false } },
			});
		});
		await expect(
			bindSystemBundledPluginLlm(actionCtx, 'alpha').generate({
				tier: 'fast',
				prompt: 'must be denied',
			})
		).rejects.toMatchObject({ code: 'access_denied' });
		expect(resolveLanguageModelWithProvenance).not.toHaveBeenCalled();
		expect(providerGenerate).not.toHaveBeenCalled();
		await t.run(async (ctx) => {
			expect(await ctx.db.query('pluginLlmReservations').take(1)).toEqual([]);
			const audit = await ctx.db.query('auditLogs').unique();
			expect(audit).toMatchObject({
				userId: 'system:bundled_plugin',
				action: 'plugin.action_denied',
			});
			expect(audit?.details).toMatchObject({ outcome: 'denied' });
		});
	});

	it('denies background dispatch when the plugin feature flag is disabled', async () => {
		const { t, actionCtx } = await setup();
		await t.run(async (ctx) => {
			const settings = await ctx.db.query('instanceSettings').unique();
			await ctx.db.patch(settings!._id, { featureFlags: { 'plugin.alpha': false } });
		});
		await expect(
			bindSystemBundledPluginLlm(actionCtx, 'alpha').generate({
				tier: 'fast',
				prompt: 'FLAG_DENIAL_SECRET',
			})
		).rejects.toMatchObject({ code: 'access_denied' });
		expect(resolveLanguageModelWithProvenance).not.toHaveBeenCalled();
		expect(providerGenerate).not.toHaveBeenCalled();
		await expectSystemDenialState(t, 'FLAG_DENIAL_SECRET');
	});

	it('denies background dispatch when a declared environment variable is missing', async () => {
		const { t, actionCtx } = await setup();
		registry.plugins[0]!.manifest.flag.requiredEnvVars = ['PP09_REQUIRED_KEY_NOT_PRESENT'];
		await expect(
			bindSystemBundledPluginLlm(actionCtx, 'alpha').generate({
				tier: 'fast',
				prompt: 'ENV_DENIAL_SECRET',
			})
		).rejects.toMatchObject({ code: 'access_denied' });
		expect(resolveLanguageModelWithProvenance).not.toHaveBeenCalled();
		expect(providerGenerate).not.toHaveBeenCalled();
		await expectSystemDenialState(t, 'ENV_DENIAL_SECRET');
	});

	it('denies background dispatch when the hard daily budget cannot admit a call', async () => {
		const { t, actionCtx } = await setup();
		registry.plugins[0]!.manifest.llmBudget.dailyUsd = 0.000001;
		await expect(
			bindSystemBundledPluginLlm(actionCtx, 'alpha').generate({
				tier: 'fast',
				prompt: 'BUDGET_DENIAL_SECRET',
			})
		).rejects.toMatchObject({ code: 'access_denied' });
		expect(resolveLanguageModelWithProvenance).toHaveBeenCalledTimes(1);
		expect(providerGenerate).not.toHaveBeenCalled();
		await expectSystemDenialState(t, 'BUDGET_DENIAL_SECRET');
	});

	it('routes bounded requests through dispatch and returns normalized attribution', async () => {
		const { t, service } = await setup();
		const result = await service.generate({ tier: 'fast', prompt: 'hello' });
		expect(result).toEqual({
			text: 'safe result',
			modelUsed: 'gpt-4o-mini',
			usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
		});
		expect(resolveLanguageModelWithProvenance).toHaveBeenCalledWith(expect.anything(), 'summarize');
		expect(providerGenerate).toHaveBeenCalledWith(
			expect.objectContaining({ maxOutputTokens: 2048 })
		);
		await t.run(async (ctx) => {
			const reservation = await ctx.db.query('pluginLlmReservations').unique();
			expect(reservation).toMatchObject({
				pluginId: 'alpha',
				modelId: 'gpt-4o-mini',
				endpointProvenance: 'openai-native',
				status: 'completed',
				tier: 'fast',
			});
			expect(await ctx.db.query('llmUsageEvents').unique()).toMatchObject({ pluginId: 'alpha' });
			expect(await ctx.db.query('pluginLlmDailyUsage').unique()).toMatchObject({
				chargedMicrousd: reservation?.chargedMicrousd,
				actualMicrousd: reservation?.actualMicrousd,
			});
			expect(reservation?.chargedMicrousd).toBeLessThan(reservation?.reservedMicrousd ?? 0);
		});
	});

	it('retains conservative charge when the provider reports an alias or rerouted model', async () => {
		const { t, service } = await setup();
		providerGenerate.mockResolvedValueOnce(
			providerGenerationResult({ modelId: 'gpt-4o-mini-provider-alias' }, 'rerouted result')
		);

		await expect(service.generate({ tier: 'fast', prompt: 'hello' })).resolves.toMatchObject({
			text: 'rerouted result',
			modelUsed: 'gpt-4o-mini-provider-alias',
		});

		await t.run(async (ctx) => {
			const reservation = await ctx.db.query('pluginLlmReservations').unique();
			expect(reservation).toMatchObject({ status: 'completed', actualMicrousd: 0 });
			expect(reservation?.chargedMicrousd).toBe(reservation?.reservedMicrousd);
			expect(await ctx.db.query('pluginLlmDailyUsage').unique()).toMatchObject({
				chargedMicrousd: reservation?.reservedMicrousd,
				actualMicrousd: 0,
			});
			expect(await ctx.db.query('llmUsageEvents').take(1)).toEqual([]);
			const audits = await ctx.db.query('auditLogs').take(5);
			expect(JSON.stringify(audits)).not.toContain('gpt-4o-mini-provider-alias');
		});
	});

	it.each([
		['absent', undefined],
		['malformed', { modelId: ' provider-secret-alias ' }],
	])('retains conservative charge when provider model metadata is %s', async (_label, response) => {
		const { t, service } = await setup();
		providerGenerate.mockResolvedValueOnce(
			providerGenerationResult(response, 'unattributed result')
		);

		await expect(service.generate({ tier: 'fast', prompt: 'hello' })).resolves.toMatchObject({
			text: 'unattributed result',
			modelUsed: undefined,
		});

		await t.run(async (ctx) => {
			const reservation = await ctx.db.query('pluginLlmReservations').unique();
			expect(reservation?.chargedMicrousd).toBe(reservation?.reservedMicrousd);
			expect(await ctx.db.query('pluginLlmDailyUsage').unique()).toMatchObject({
				chargedMicrousd: reservation?.reservedMicrousd,
				actualMicrousd: 0,
			});
			expect(await ctx.db.query('llmUsageEvents').take(1)).toEqual([]);
			expect(JSON.stringify(await ctx.db.query('auditLogs').take(5))).not.toContain(
				'provider-secret-alias'
			);
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
		expect(resolveLanguageModelWithProvenance).not.toHaveBeenCalled();
		expect(providerGenerate).not.toHaveBeenCalled();
	});

	it('denies a grant revoked after preflight but before the reservation transaction', async () => {
		const { t, service } = await setup();
		vi.mocked(resolveLanguageModelWithProvenance).mockImplementationOnce(async () => {
			await t.run(async (ctx) => {
				const settings = await ctx.db.query('instanceSettings').unique();
				await ctx.db.patch(settings!._id, {
					pluginCapabilityGrants: { 'plugin.alpha': { 'llm:invoke': false } },
				});
			});
			return {
				model: 'gpt-4o-mini' as never,
				modelId: 'gpt-4o-mini',
				endpointProvenance: 'openai-native',
			};
		});
		await expect(service.generate({ tier: 'fast', prompt: 'safe' })).rejects.toMatchObject({
			code: 'access_denied',
		});
		expect(resolveLanguageModelWithProvenance).toHaveBeenCalledTimes(1);
		expect(providerGenerate).not.toHaveBeenCalled();
		await t.run(async (ctx) => {
			expect(await ctx.db.query('pluginLlmReservations').take(1)).toEqual([]);
		});
	});

	it('retains the full reservation on provider failure without logging the error', async () => {
		const { t, service } = await setup();
		providerGenerate.mockRejectedValue({
			statusCode: 401,
			message: 'provider leaked TOP_SECRET',
		});
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

	it('fails closed before reservation for an exact cheap model on a custom endpoint', async () => {
		const { t, service } = await setup();
		vi.mocked(resolveLanguageModelWithProvenance).mockResolvedValueOnce({
			model: 'gpt-4o-mini' as never,
			modelId: 'gpt-4o-mini',
			endpointProvenance: 'custom',
		});
		await expect(service.generate({ tier: 'fast', prompt: 'hello' })).rejects.toMatchObject({
			code: 'access_denied',
		});
		expect(providerGenerate).not.toHaveBeenCalled();
		await t.run(async (ctx) => {
			expect(await ctx.db.query('pluginLlmReservations').take(1)).toEqual([]);
		});
	});
});

async function expectSystemDenialState(
	t: Awaited<ReturnType<typeof setup>>['t'],
	forbiddenText: string
): Promise<void> {
	await t.run(async (ctx) => {
		expect(await ctx.db.query('pluginLlmReservations').take(1)).toEqual([]);
		expect(await ctx.db.query('pluginLlmDailyUsage').take(1)).toEqual([]);
		const audits = await ctx.db.query('auditLogs').collect();
		expect(audits).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					userId: 'system:bundled_plugin',
					action: 'plugin.action_denied',
				}),
			])
		);
		expect(JSON.stringify(audits)).not.toContain(forbiddenText);
	});
}
