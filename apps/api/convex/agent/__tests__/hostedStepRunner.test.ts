import { getFunctionName } from 'convex/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const moduleState = vi.hoisted(() => ({
	calls: [] as unknown[],
	implementation: async (_input: unknown): Promise<unknown> => ({ kind: 'continue' }),
}));

vi.mock('../../plugins/agentStepCatalog.generated', () => ({
	BUNDLED_PLUGIN_AGENT_STEP_CATALOG: Object.freeze([
		Object.freeze({
			kind: 'plugin.policy-pack.spam-score',
			pluginId: 'policy-pack',
			after: 'security_scan',
			continuationStatus: 'classifying',
			lifecycleEdges: Object.freeze([{ from: 'classifying', to: 'archived' }]),
			requiredCapability: 'agent:step',
		}),
	]),
}));

vi.mock('../../plugins/agentStepModules.generated', () => ({
	BUNDLED_PLUGIN_AGENT_STEP_MODULES: Object.freeze([
		Object.freeze({
			kind: 'plugin.policy-pack.spam-score',
			pluginId: 'policy-pack',
			module: {
				execute: async (input: unknown) => {
					moduleState.calls.push(input);
					return moduleState.implementation(input);
				},
			},
		}),
	]),
}));

import { runHostedPluginStep } from '../hostedStepRunner';

const kind = 'plugin.policy-pack.spam-score' as never;

function fakeContext(authorized = true) {
	const calls: string[] = [];
	return {
		calls,
		ctx: {
			runMutation: vi.fn(async (reference: unknown) => {
				const name = getFunctionName(reference as never);
				calls.push(name);
				if (name.endsWith(':authorizeExecution')) return authorized;
				if (name.endsWith(':recordStepBegin')) return { actionId: 'action-id' };
				if (name.endsWith(':transition')) {
					return { ok: true, applied: 'transitioned', from: 'classifying', to: 'failed' };
				}
			}),
			runQuery: vi.fn(async () => ({
				_id: 'message-id',
				from: 'sender@example.com',
				to: 'inbox@example.com',
				subject: 'Subject',
				textBody: 'Body',
				processingStatus: 'classifying',
			})),
		},
	};
}

describe('hosted plugin agent step runner', () => {
	beforeEach(() => {
		moduleState.calls.length = 0;
		moduleState.implementation = async () => ({ kind: 'continue' });
	});

	it('skips disabled or ungranted code without changing the host continuation', async () => {
		const { ctx, calls } = fakeContext(false);
		const continuePipeline = vi.fn(async () => undefined);

		await runHostedPluginStep(
			ctx as never,
			{ inboundMessageId: 'message-id' as never, kind },
			continuePipeline
		);
		expect(moduleState.calls).toEqual([]);
		expect(continuePipeline).toHaveBeenCalledOnce();
		expect(calls).toEqual(['plugins/agentStepAuthorization:authorizeExecution']);
	});

	it('records a bounded successful result and resumes the exact host continuation', async () => {
		moduleState.implementation = async () => ({ kind: 'continue', output: { score: 42 } });
		const { ctx, calls } = fakeContext();
		const continuePipeline = vi.fn(async () => undefined);

		await runHostedPluginStep(
			ctx as never,
			{ inboundMessageId: 'message-id' as never, kind },
			continuePipeline
		);

		expect(moduleState.calls).toEqual([expect.objectContaining({ textBody: 'Body' })]);
		expect(continuePipeline).toHaveBeenCalledOnce();
		expect(calls).toEqual([
			'plugins/agentStepAuthorization:authorizeExecution',
			'inbox/processingLifecycle:recordStepBegin',
			'inbox/processingLifecycle:recordStepEnd',
			'plugins/agentStepAuthorization:recordOutcome',
		]);
	});

	it('fails closed on module errors and never resumes the continuation', async () => {
		moduleState.implementation = async () => {
			throw new Error('secret provider detail');
		};
		const { ctx, calls } = fakeContext();
		const continuePipeline = vi.fn(async () => undefined);

		await runHostedPluginStep(
			ctx as never,
			{ inboundMessageId: 'message-id' as never, kind },
			continuePipeline
		);
		expect(continuePipeline).not.toHaveBeenCalled();
		expect(calls).toContain('inbox/processingLifecycle:transition');
		expect(calls[calls.length - 1]).toBe('plugins/agentStepAuthorization:recordOutcome');
	});

	it('rejects a caution edge that was not declared by the manifest', async () => {
		moduleState.implementation = async () => ({
			kind: 'caution',
			to: 'draft_ready',
			reason: 'Review',
		});
		const { ctx, calls } = fakeContext();

		await runHostedPluginStep(
			ctx as never,
			{ inboundMessageId: 'message-id' as never, kind },
			vi.fn(async () => undefined)
		);

		expect(calls).toContain('inbox/processingLifecycle:transition');
		expect(calls).not.toContain('inbox/processingLifecycle:recordStepEnd');
	});
});
