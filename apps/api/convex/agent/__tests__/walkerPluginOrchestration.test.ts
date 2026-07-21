import { getFunctionName } from 'convex/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureState = vi.hoisted(() => ({
	executed: [] as string[],
	results: new Map<string, unknown>(),
}));

const fixtureCatalog = vi.hoisted(
	() =>
		[
			{
				kind: 'plugin.policy-pack.first',
				pluginId: 'policy-pack',
				after: 'security_scan',
				continuationStatus: 'classifying',
				placement: 'classification',
				lifecycleEdges: [
					{ kind: 'caution', from: 'classifying', to: 'archived' },
					{ kind: 'caution', from: 'classifying', to: 'failed' },
				],
				requiredCapability: 'agent:step',
			},
			{
				kind: 'plugin.policy-pack.first-child',
				pluginId: 'policy-pack',
				after: 'plugin.policy-pack.first',
				continuationStatus: 'classifying',
				placement: 'classification',
				lifecycleEdges: [],
				requiredCapability: 'agent:step',
			},
			{
				kind: 'plugin.policy-pack.sibling',
				pluginId: 'policy-pack',
				after: 'security_scan',
				continuationStatus: 'classifying',
				placement: 'classification',
				lifecycleEdges: [],
				requiredCapability: 'agent:step',
			},
			{
				kind: 'plugin.policy-pack.after-clarify',
				pluginId: 'policy-pack',
				after: 'clarify',
				continuationStatus: 'drafting',
				placement: 'before_draft',
				lifecycleEdges: [{ kind: 'caution', from: 'drafting', to: 'failed' }],
				requiredCapability: 'agent:step',
			},
			{
				kind: 'plugin.policy-pack.after-draft',
				pluginId: 'policy-pack',
				after: 'draft',
				continuationStatus: 'drafting',
				placement: 'after_draft',
				lifecycleEdges: [{ kind: 'draft_review', from: 'drafting', to: 'draft_ready' }],
				requiredCapability: 'agent:step',
			},
		] as const
);

vi.mock('../../plugins/agentStepCatalog.generated', () => ({
	BUNDLED_PLUGIN_AGENT_STEP_CATALOG: Object.freeze(
		fixtureCatalog.map((definition) =>
			Object.freeze({
				...definition,
				lifecycleEdges: Object.freeze(definition.lifecycleEdges.map((edge) => Object.freeze(edge))),
			})
		)
	),
}));

vi.mock('../../plugins/agentStepModules.generated', () => ({
	BUNDLED_PLUGIN_AGENT_STEP_MODULES: Object.freeze(
		fixtureCatalog.map((definition) =>
			Object.freeze({
				kind: definition.kind,
				pluginId: definition.pluginId,
				module: {
					execute: async () => {
						fixtureState.executed.push(definition.kind);
						return fixtureState.results.get(definition.kind) ?? { kind: 'continue' };
					},
				},
			})
		)
	),
}));

vi.mock('../steps/security_scan', () => ({
	securityScanStep: {
		kind: 'security_scan',
		execute: async () => ({ output: { clean: true } }),
		route: (_output: unknown, input: { continuationToken: string }) => ({
			kind: 'in_state',
			nextStep: {
				kind: 'context_retrieval',
				input: { continuationToken: input.continuationToken },
			},
		}),
	},
}));

vi.mock('../steps/context_retrieval', () => ({
	contextRetrievalStep: {
		kind: 'context_retrieval',
		execute: async () => ({ output: { context: 'fixture retrieval context' } }),
		route: () => ({ kind: 'done' }),
	},
}));

import { resumeDraft, runStep } from '../walker';

type WalkerHandler = (ctx: unknown, args: Record<string, unknown>) => Promise<void>;
const runStepHandler = (runStep as unknown as { _handler: WalkerHandler })._handler;
const resumeDraftHandler = (resumeDraft as unknown as { _handler: WalkerHandler })._handler;

interface ScheduledStep {
	readonly inboundMessageId: string;
	readonly kind: string;
	readonly input: unknown;
	readonly remainingPluginSteps?: readonly string[];
	readonly coreStep?: { readonly kind: string; readonly input: unknown };
}

function createHarness() {
	const scheduled: ScheduledStep[] = [];
	const actionStatuses = new Map<string, 'running' | 'completed' | 'failed'>();
	const revoked = new Set<string>();
	let actionCounter = 0;
	let rejectedTransitions = 0;
	let rejectScheduling = false;
	const message: Record<string, unknown> = {
		_id: 'message-id',
		from: 'sender@example.com',
		to: 'inbox@example.com',
		subject: 'Subject',
		textBody: 'Body',
		processingStatus: 'classifying',
	};
	const ctx = {
		runQuery: vi.fn(async (reference: unknown) => {
			const name = getFunctionName(reference as never);
			if (name.endsWith(':getAgentConfig')) return null;
			if (name.endsWith(':getMessage')) return message;
			throw new Error(`Unexpected query ${name}`);
		}),
		runMutation: vi.fn(async (reference: unknown, args: Record<string, unknown>) => {
			const name = getFunctionName(reference as never);
			if (name.endsWith(':authorizeExecution')) {
				return !revoked.has(args['stepKind'] as string);
			}
			if (name.endsWith(':recordStepBegin')) {
				const actionId = `action-${++actionCounter}`;
				actionStatuses.set(actionId, 'running');
				return { actionId };
			}
			if (name.endsWith(':recordStepEnd')) {
				actionStatuses.set(args['actionId'] as string, 'completed');
				return;
			}
			if (name.endsWith(':recordStepFail')) {
				actionStatuses.set(args['actionId'] as string, 'failed');
				return;
			}
			if (name.endsWith(':recordOutcome')) return;
			if (name.endsWith(':transition')) {
				if (rejectedTransitions > 0) {
					rejectedTransitions -= 1;
					return { ok: false, reason: 'fixture rejection' };
				}
				const input = args['input'] as Record<string, unknown>;
				const actionId = (input['completedActionId'] ?? input['failingActionId']) as
					| string
					| undefined;
				if (actionId) {
					actionStatuses.set(actionId, input['failingActionId'] ? 'failed' : 'completed');
				}
				message['processingStatus'] = input['to'];
				return { ok: true, applied: 'transitioned' };
			}
			throw new Error(`Unexpected mutation ${name}`);
		}),
		scheduler: {
			runAfter: vi.fn(async (_delay: number, _reference: unknown, args: ScheduledStep) => {
				if (rejectScheduling) throw new Error('fixture scheduler unavailable');
				scheduled.push(args);
			}),
		},
	};
	return {
		actionStatuses,
		ctx,
		message,
		revoked,
		scheduled,
		rejectNextTransition: () => {
			rejectedTransitions += 1;
		},
		rejectFutureScheduling: () => {
			rejectScheduling = true;
		},
	};
}

async function runScheduled(harness: ReturnType<typeof createHarness>): Promise<ScheduledStep> {
	const step = harness.scheduled.shift();
	if (!step) throw new Error('Expected a scheduled fixture step');
	await runStepHandler(harness.ctx, step as unknown as Record<string, unknown>);
	return step;
}

function expectNoRunningActions(harness: ReturnType<typeof createHarness>): void {
	expect([...harness.actionStatuses.values()]).not.toContain('running');
}

describe('walker generated plugin orchestration conformance', () => {
	beforeEach(() => {
		fixtureState.executed.length = 0;
		fixtureState.results.clear();
	});

	it('runs sibling and nested plugins in depth-first order, then preserves the core continuation', async () => {
		const harness = createHarness();
		await runStepHandler(harness.ctx, {
			inboundMessageId: 'message-id',
			kind: 'security_scan',
			input: { continuationToken: 'preserved' },
		});

		expect(harness.scheduled[0]).toMatchObject({
			kind: 'plugin.policy-pack.first',
			remainingPluginSteps: ['plugin.policy-pack.first-child', 'plugin.policy-pack.sibling'],
			coreStep: {
				kind: 'context_retrieval',
				input: { continuationToken: 'preserved' },
			},
		});
		await runScheduled(harness);
		await runScheduled(harness);
		await runScheduled(harness);
		expect(fixtureState.executed).toEqual([
			'plugin.policy-pack.first',
			'plugin.policy-pack.first-child',
			'plugin.policy-pack.sibling',
		]);
		expect(harness.scheduled).toEqual([
			expect.objectContaining({
				kind: 'context_retrieval',
				input: { continuationToken: 'preserved' },
			}),
		]);
		expectNoRunningActions(harness);
	});

	it('skips a revoked nested plugin and continues the remaining chain', async () => {
		const harness = createHarness();
		await runStepHandler(harness.ctx, {
			inboundMessageId: 'message-id',
			kind: 'security_scan',
			input: { continuationToken: 'kept' },
		});
		await runScheduled(harness);
		harness.revoked.add('plugin.policy-pack.first-child');
		await runScheduled(harness);
		await runScheduled(harness);
		expect(fixtureState.executed).toEqual([
			'plugin.policy-pack.first',
			'plugin.policy-pack.sibling',
		]);
		expect(harness.scheduled[0]?.kind).toBe('context_retrieval');
		expectNoRunningActions(harness);
	});

	it.each([
		['archived', 'plugin.policy-pack.first', 'classifying', undefined],
		['failed', 'plugin.policy-pack.first', 'classifying', undefined],
		['draft_ready', 'plugin.policy-pack.after-draft', 'drafting', 'Persisted draft'],
	] as const)(
		'stops cleanly on the %s terminal branch',
		async (to, kind, status, draftResponse) => {
			const harness = createHarness();
			harness.message['processingStatus'] = status;
			harness.message['draftResponse'] = draftResponse;
			fixtureState.results.set(kind, { kind: 'caution', to, reason: 'fixture caution' });
			await runStepHandler(harness.ctx, {
				inboundMessageId: 'message-id',
				kind,
				input: { inboundMessageId: 'message-id' },
				remainingPluginSteps: [],
				coreStep: { kind: 'route', input: { mustNotRun: true } },
			});
			expect(harness.scheduled).toEqual([]);
			expect(harness.message['processingStatus']).toBe(to);
			expectNoRunningActions(harness);
		}
	);

	it('closes the plugin action when its lifecycle transition is rejected', async () => {
		const harness = createHarness();
		harness.rejectNextTransition();
		fixtureState.results.set('plugin.policy-pack.first', {
			kind: 'caution',
			to: 'archived',
			reason: 'fixture caution',
		});
		await runStepHandler(harness.ctx, {
			inboundMessageId: 'message-id',
			kind: 'plugin.policy-pack.first',
			input: { inboundMessageId: 'message-id' },
		});
		expect(harness.message['processingStatus']).toBe('failed');
		expectNoRunningActions(harness);
	});

	it('leaves no running action when continuation scheduling fails', async () => {
		const harness = createHarness();
		harness.rejectFutureScheduling();
		await runStepHandler(harness.ctx, {
			inboundMessageId: 'message-id',
			kind: 'plugin.policy-pack.first',
			input: { inboundMessageId: 'message-id' },
			coreStep: { kind: 'context_retrieval', input: { preserved: true } },
		});
		expect(harness.message['processingStatus']).toBe('failed');
		expectNoRunningActions(harness);
	});

	it.each([
		[
			'answered',
			{
				questions: [
					{
						id: 'q1',
						slotType: 'free_text',
						text: 'Which region?',
						answer: { value: 'Europe', source: 'user', at: 2 },
					},
				],
				askedAt: 1,
				answeredAt: 2,
			},
		],
		['abandoned', undefined],
	] as const)(
		'resumes %s clarification through the generated pre-draft chain',
		async (_case, pending) => {
			const harness = createHarness();
			harness.message['processingStatus'] = 'drafting';
			harness.message['pendingClarification'] = pending;
			harness.message['classification'] = {
				category: 'other',
				priority: 'normal',
				sentiment: 'neutral',
				intent: 'other',
				confidence: 0.5,
			};
			await resumeDraftHandler(harness.ctx, { inboundMessageId: 'message-id' });
			expect(harness.scheduled).toHaveLength(1);
			expect(harness.scheduled[0]).toMatchObject({
				kind: 'plugin.policy-pack.after-clarify',
				remainingPluginSteps: [],
				coreStep: {
					kind: 'draft',
					input: {
						context: 'fixture retrieval context',
						confirmedContext: pending ? expect.stringContaining('Europe') : '',
					},
				},
			});
		}
	);
});
