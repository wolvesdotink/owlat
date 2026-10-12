/**
 * The Phase 2 bundle runs end to end (ADR-0073): the scheduled actions, the
 * runner, the artifact lease and the ledger, with the provider calls and the
 * admission seam mocked. Never a paid provider.
 *
 * - Default off makes no calls.
 * - One call per bundle, on the rung the ladder picks.
 * - Shadow obeys admission's caps.
 * - Advisory results never change routing.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import {
	createTestContact,
	createTestInboundMessage,
	enableFeatures,
} from '../../__tests__/factories';
import { seedFolder, seedMailbox, seedMessage } from '../../mail/__tests__/helpers.testlib';

const mocks = vi.hoisted(() => ({
	runLlmObject: vi.fn(),
	runDecision: vi.fn(),
	admitBundle: vi.fn(),
	plane: {
		kind: 'llm' as string,
		unavailable: undefined as { code: string; reason: string } | undefined,
		updatedAt: undefined as number | undefined,
	},
}));

vi.mock('../../lib/llm/dispatch', async () => {
	const { metered } = await import('../../analytics/__tests__/meteredDispatch.testlib');
	return {
		...(await vi.importActual<object>('../../lib/llm/dispatch')),
		runLlmObject: metered((opts: unknown) => mocks.runLlmObject(opts)),
	};
});
vi.mock('../../lib/llmProvider', async () => ({
	...(await vi.importActual<object>('../../lib/llmProvider')),
	resolveLanguageModel: vi.fn(async () => 'mock-model'),
}));
vi.mock('../../lib/decisionProvider', async () => ({
	...(await vi.importActual<object>('../../lib/decisionProvider')),
	resolveDecisionConfig: vi.fn(async () => ({
		...mocks.plane,
		clientConfig: {},
		...(mocks.plane.updatedAt === undefined ? {} : { updatedAt: mocks.plane.updatedAt }),
	})),
	resolveDecisionProvider: vi.fn(async () => ({ kind: mocks.plane.kind, config: {} })),
}));
vi.mock('../../lib/decision/dispatch', async () => ({
	...(await vi.importActual<object>('../../lib/decision/dispatch')),
	runDecision: (opts: unknown) => mocks.runDecision(opts),
}));
vi.mock('../bundleAdmission', () => ({ admitBundle: mocks.admitBundle }));

const rootGlob = import.meta.glob('../../**/*.*s');
const decisionGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../decision/'),
		mod,
	])
);
const modules = Object.fromEntries(
	Object.entries({ ...rootGlob, ...decisionGlob }).filter(
		([path]) => !path.includes('knowledgeExtraction') && !path.includes('llmProvider')
	)
);

type T = ReturnType<typeof convexTest>;

function admitted(mode: 'shadow' | 'advisory' = 'shadow') {
	return {
		isAdmitted: true,
		target: {
			feature: 'decision_triage',
			task: 'mail.triage',
			...(mode === 'shadow' ? { budgetClass: 'shadow' } : {}),
		},
		decision: { recordUsage: vi.fn() },
	};
}

async function setup(policy: Record<string, unknown> | null): Promise<T> {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	await enableFeatures(t, ['ai.agent', 'ai']);
	if (policy) {
		await t.run(async (ctx) => {
			await ctx.db.insert('aiRoutingPolicy', {
				...policy,
				shadowCapUsd: 1,
				policyVersion: 7,
				updatedAt: Date.now(),
				updatedBy: 'admin-1',
			});
		});
	}
	return t;
}

async function seedTeamMessage(
	t: T,
	over: Record<string, unknown> = {}
): Promise<Id<'inboundMessages'>> {
	return t.run(async (ctx) => {
		const contactId = await ctx.db.insert(
			'contacts',
			createTestContact({ email: 'ada@example.com' })
		);
		const threadId = await ctx.db.insert('conversationThreads', {
			subject: 'Where is my order?',
			normalizedSubject: 'where is my order?',
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
				to: 'support@owlat.test',
				subject: 'Where is my order?',
				textBody: 'Hello, my order 42 has not arrived. Can you check?',
				htmlBody: undefined,
				processingStatus: 'drafting',
				dmarcResult: 'pass',
				contactId,
				threadId,
				classification: {
					category: 'support',
					priority: 'normal',
					sentiment: 'neutral',
					intent: 'question',
					confidence: 0.9,
					language: 'en',
				},
				...over,
			})
		);
	});
}

const artifacts = (t: T) => t.run((ctx) => ctx.db.query('decisionArtifacts').collect());

beforeEach(() => {
	mocks.plane.kind = 'llm';
	mocks.plane.unavailable = undefined;
	mocks.plane.updatedAt = undefined;
	mocks.admitBundle.mockResolvedValue(admitted());
	mocks.runLlmObject.mockResolvedValue({
		object: { triage: 'needs_work' },
		tokenUsage: { promptTokens: 300, completionTokens: 5, totalTokens: 305 },
		modelUsed: 'gpt-6-luna',
	});
	mocks.runDecision.mockResolvedValue({
		answers: {
			category: { kind: 'choice', value: 'spam', probabilities: { spam: 0.97 }, confidence: 0.97 },
			disposition: { kind: 'noul', probability: 0.02 },
		},
		usage: { promptTokens: 300, completionTokens: 3, totalTokens: 303 },
		modelUsed: 'jev-1.13.0',
		provenance: 'typesafe-native',
		calibrated: true,
		provider: 'typesafe',
		fallback: false,
		requestId: 'r1',
		attempts: 1,
	});
});
afterEach(() => vi.clearAllMocks());

describe('default posture', () => {
	it('makes no call, asks no admission and writes nothing with every switch off', async () => {
		const t = await setup(null);
		const inboundMessageId = await seedTeamMessage(t);
		await t.action(internal.decision.bundleActions.teamTriage, { inboundMessageId });
		await t.action(internal.decision.bundleActions.teamMessage, {
			inboundMessageId,
			baseline: { category: 'support', disposition: 'reply' },
		});
		expect(mocks.runLlmObject).not.toHaveBeenCalled();
		expect(mocks.runDecision).not.toHaveBeenCalled();
		expect(mocks.admitBundle).not.toHaveBeenCalled();
		expect(await artifacts(t)).toEqual([]);
		expect(await t.run((ctx) => ctx.db.query('senderMemory').collect())).toEqual([]);
	});
});

describe('the triage shadow (D11)', () => {
	it('is ONE fast-tier call on the language rung, admitted as shadow and metered once', async () => {
		const t = await setup({ triageBundle: 'shadow' });
		const inboundMessageId = await seedTeamMessage(t);
		await t.action(internal.decision.bundleActions.teamTriage, { inboundMessageId });

		expect(mocks.runDecision).not.toHaveBeenCalled();
		expect(mocks.runLlmObject).toHaveBeenCalledTimes(1);
		expect(mocks.admitBundle).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				task: 'mail.triage',
				mode: 'shadow',
				subjectKey: inboundMessageId,
				// Bounded by the action's model budget (clarify lane, Sol r1 F1).
				root: { rootRequestId: `team:${inboundMessageId}`, deadlineAt: expect.any(Number) },
				policyVersion: 7,
				// The selected rung's plane (Sol r7 F1).
				plane: 'language',
			})
		);
		const [artifact] = await artifacts(t);
		expect(artifact).toMatchObject({
			task: 'mail.triage',
			kind: 'shadow',
			status: 'complete',
			inboundMessageId,
			policyVersion: 7,
			provenance: { provider: 'language', modelUsed: 'gpt-6-luna', questionSetId: 'mail.triage' },
			calibration: { isAdapterCalibrated: false },
		});
		expect(artifact!.calibration).not.toHaveProperty('calibrationRevision');
		expect(JSON.parse(artifact!.answers!).labels).toEqual({ triage: 'needs_work' });
		expect(artifact!.answers).not.toContain('order 42');

		const ledger = await t.run((ctx) => ctx.db.query('llmUsageEvents').collect());
		expect(ledger).toHaveLength(1);
		expect(ledger[0]).toMatchObject({
			feature: 'decision_triage',
			task: 'mail.triage',
			plane: 'language',
			budgetClass: 'shadow',
			rootRequestId: `team:${inboundMessageId}`,
		});
	});

	it('never asks the same message twice', async () => {
		const t = await setup({ triageBundle: 'shadow' });
		const inboundMessageId = await seedTeamMessage(t);
		await t.action(internal.decision.bundleActions.teamTriage, { inboundMessageId });
		await t.action(internal.decision.bundleActions.teamTriage, { inboundMessageId });
		expect(mocks.runLlmObject).toHaveBeenCalledTimes(1);
		expect(await artifacts(t)).toHaveLength(1);
	});

	it.each(['not_sampled', 'no_allowance', 'not_shadowed'])(
		'obeys admission: %s makes no call and no artifact',
		async (why) => {
			mocks.admitBundle.mockResolvedValue({ isAdmitted: false, why });
			const t = await setup({ triageBundle: 'shadow' });
			const inboundMessageId = await seedTeamMessage(t);
			await t.action(internal.decision.bundleActions.teamTriage, { inboundMessageId });
			expect(mocks.runLlmObject).not.toHaveBeenCalled();
			expect(await artifacts(t)).toEqual([]);
		}
	);

	it('never judges a message the guard has not cleared, nor ciphertext', async () => {
		const t = await setup({ triageBundle: 'shadow' });
		const quarantined = await seedTeamMessage(t, { processingStatus: 'quarantined' });
		const unguarded = await seedTeamMessage(t, {
			securityFlags: {
				injectionDetected: false,
				confidence: 0,
				scanTimestamp: 1,
				guardNotRun: { reason: 'agent_disabled', at: 1 },
			},
		});
		const encrypted = await seedTeamMessage(t, {
			textBody: '-----BEGIN PGP MESSAGE-----\n\nhQEMA0x\n-----END PGP MESSAGE-----',
		});
		for (const inboundMessageId of [quarantined, unguarded, encrypted]) {
			await t.action(internal.decision.bundleActions.teamTriage, { inboundMessageId });
		}
		expect(mocks.admitBundle).not.toHaveBeenCalled();
		expect(mocks.runLlmObject).not.toHaveBeenCalled();
	});

	it('stores a failed attempt as failed, after the call was metered', async () => {
		mocks.runLlmObject.mockRejectedValue(new Error('provider down'));
		const t = await setup({ triageBundle: 'shadow' });
		const inboundMessageId = await seedTeamMessage(t);
		await t.action(internal.decision.bundleActions.teamTriage, { inboundMessageId });
		const [artifact] = await artifacts(t);
		expect(artifact).toMatchObject({ status: 'failed' });
		expect(await t.run((ctx) => ctx.db.query('llmUsageEvents').collect())).toHaveLength(1);
	});
});

describe('the message bundle', () => {
	const baseline = { category: 'support', disposition: 'reply' };

	it('asks nothing on the language rung: there, today’s classifier IS the rung', async () => {
		const t = await setup({ categoryDisplayBundle: 'enforce' });
		const inboundMessageId = await seedTeamMessage(t);
		await t.action(internal.decision.bundleActions.teamMessage, { inboundMessageId, baseline });
		expect(mocks.runLlmObject).not.toHaveBeenCalled();
		expect(mocks.runDecision).not.toHaveBeenCalled();
		expect(mocks.admitBundle).not.toHaveBeenCalled();
	});

	it('is ONE decision call on the decision rung, with no fallback hop', async () => {
		mocks.plane.kind = 'typesafe';
		mocks.admitBundle.mockResolvedValue(admitted('advisory'));
		const t = await setup({ categoryDisplayBundle: 'enforce' });
		await enableFeatures(t, ['ai.decisionPlane']);
		const inboundMessageId = await seedTeamMessage(t);
		await t.action(internal.decision.bundleActions.teamMessage, {
			inboundMessageId,
			baseline,
			language: 'en',
		});

		expect(mocks.runLlmObject).not.toHaveBeenCalled();
		expect(mocks.runDecision).toHaveBeenCalledTimes(1);
		expect(mocks.admitBundle).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ task: 'mail.category', plane: 'decision' })
		);
		const options = mocks.runDecision.mock.calls[0]![0] as Record<string, unknown>;
		expect(options).not.toHaveProperty('fallbackTo');
		expect(options).toMatchObject({
			feature: 'decision_category',
			task: 'mail.category',
			// The native dispatch's only deadline is the root's: bounded by the action's budget.
			root: { rootRequestId: `team:${inboundMessageId}`, deadlineAt: expect.any(Number) },
			allowance: expect.objectContaining({ allowed: true }),
			recordUsage: expect.any(Function),
		});
		const [artifact] = await artifacts(t);
		expect(artifact).toMatchObject({
			task: 'mail.category',
			kind: 'advisory',
			status: 'complete',
			contextVersion: 'typesafe||',
			provenance: {
				provider: 'typesafe',
				endpoint: 'typesafe-native',
				questionSetId: 'mail.message.team',
			},
			calibration: { isAdapterCalibrated: true, language: 'en' },
			isAgreement: false,
		});
		expect(JSON.parse(artifact!.answers!).labels).toEqual({
			category: 'spam',
			disposition: 'informational',
		});
		expect(JSON.parse(artifact!.baseline!)).toEqual(baseline);
	});

	it('never changes the message: no routing reads an advisory verdict (D9)', async () => {
		mocks.plane.kind = 'typesafe';
		mocks.admitBundle.mockResolvedValue(admitted('advisory'));
		const t = await setup({
			categoryDisplayBundle: 'enforce',
			dispositionAdvisoryBundle: 'enforce',
		});
		await enableFeatures(t, ['ai.decisionPlane']);
		const inboundMessageId = await seedTeamMessage(t);
		const before = await t.run((ctx) => ctx.db.get(inboundMessageId));
		await t.action(internal.decision.bundleActions.teamMessage, { inboundMessageId, baseline });
		const after = await t.run((ctx) => ctx.db.get(inboundMessageId));
		expect(after).toEqual(before);
		expect(await artifacts(t)).toHaveLength(1);
	});

	it('is terminal when the decision plane cannot even be resolved (D3)', async () => {
		const { resolveDecisionConfig } = await import('../../lib/decisionProvider');
		vi.mocked(resolveDecisionConfig).mockRejectedValueOnce(new Error('undecryptable'));
		const t = await setup({ triageBundle: 'shadow' });
		await enableFeatures(t, ['ai.decisionPlane']);
		const inboundMessageId = await seedTeamMessage(t);
		await t.action(internal.decision.bundleActions.teamTriage, { inboundMessageId });
		expect(mocks.runLlmObject).not.toHaveBeenCalled();
		expect(mocks.admitBundle).not.toHaveBeenCalled();
	});

	it('is terminal when the configured decision provider cannot answer (D3)', async () => {
		mocks.plane.kind = 'typesafe';
		mocks.plane.unavailable = { code: 'missing_credentials', reason: 'no key' };
		const t = await setup({ triageBundle: 'shadow', categoryDisplayBundle: 'shadow' });
		await enableFeatures(t, ['ai.decisionPlane']);
		const inboundMessageId = await seedTeamMessage(t);
		await t.action(internal.decision.bundleActions.teamTriage, { inboundMessageId });
		await t.action(internal.decision.bundleActions.teamMessage, { inboundMessageId, baseline });
		expect(mocks.runLlmObject).not.toHaveBeenCalled();
		expect(mocks.runDecision).not.toHaveBeenCalled();
		expect(mocks.admitBundle).not.toHaveBeenCalled();
	});
});

describe('the opt-out from hosted decisions (ADR-0060 §9)', () => {
	const baseline = { category: 'support', disposition: 'reply' };

	async function excludeTeamInbox(t: T) {
		await t.run(async (ctx) => {
			await ctx.db.insert('agentConfig', {
				isAutoReplyEnabled: false,
				confidenceThreshold: 0.8,
				isExcludedFromHostedDecisions: true,
				createdAt: 1,
				updatedAt: 1,
			});
		});
	}

	it('refuses a hosted provider for the excluded Team Inbox at dispatch', async () => {
		mocks.plane.kind = 'typesafe';
		mocks.admitBundle.mockResolvedValue(admitted('advisory'));
		const t = await setup({ categoryDisplayBundle: 'enforce', triageBundle: 'shadow' });
		await enableFeatures(t, ['ai.decisionPlane']);
		await excludeTeamInbox(t);
		const inboundMessageId = await seedTeamMessage(t);
		await t.action(internal.decision.bundleActions.teamMessage, { inboundMessageId, baseline });
		await t.action(internal.decision.bundleActions.teamTriage, { inboundMessageId });
		expect(mocks.runDecision).not.toHaveBeenCalled();
		expect(mocks.runLlmObject).not.toHaveBeenCalled();
		expect(await artifacts(t)).toEqual([]);
	});

	it('refuses the language rung for it too: that model is hosted as well', async () => {
		const t = await setup({ triageBundle: 'shadow' });
		await excludeTeamInbox(t);
		const inboundMessageId = await seedTeamMessage(t);
		await t.action(internal.decision.bundleActions.teamTriage, { inboundMessageId });
		expect(mocks.runLlmObject).not.toHaveBeenCalled();
	});

	it('lets the local decision engine judge it', async () => {
		mocks.plane.kind = 'local';
		mocks.admitBundle.mockResolvedValue(admitted('advisory'));
		const t = await setup({ categoryDisplayBundle: 'enforce' });
		await enableFeatures(t, ['ai.decisionPlane']);
		await excludeTeamInbox(t);
		const inboundMessageId = await seedTeamMessage(t);
		await t.action(internal.decision.bundleActions.teamMessage, { inboundMessageId, baseline });
		expect(mocks.runDecision).toHaveBeenCalledTimes(1);
	});

	it('refuses a hosted provider for an excluded Postbox mailbox, and only that one', async () => {
		mocks.plane.kind = 'typesafe';
		mocks.admitBundle.mockResolvedValue(admitted('advisory'));
		const t = await setup({ categoryDisplayBundle: 'enforce' });
		await enableFeatures(t, ['ai.decisionPlane']);
		const excluded = await seedMailbox(t, { address: 'me@example.com' });
		await seedFolder(t, excluded, 'inbox');
		const excludedMessage = await seedMessage(t, excluded, { fromAddress: 'a@shop.example' });
		const other = await seedMailbox(t, { address: 'you@example.com' });
		await seedFolder(t, other, 'inbox');
		const otherMessage = await seedMessage(t, other, { fromAddress: 'b@shop.example' });
		const threads = await t.run(async (ctx) => {
			await ctx.db.patch(excluded, { isExcludedFromHostedDecisions: true });
			const ids = [];
			for (const id of [excludedMessage, otherMessage]) {
				const message = await ctx.db.get(id);
				await ctx.db.patch(message!.threadId, { latestMessageId: id });
				ids.push(message!.threadId);
			}
			return ids;
		});
		for (const threadId of threads) {
			await t.action(internal.decision.bundleActions.postboxMessage, {
				threadId,
				baseline: { category: 'other' },
			});
		}
		expect(mocks.runDecision).toHaveBeenCalledTimes(1);
		const [artifact] = await artifacts(t);
		expect(artifact).toMatchObject({ mailMessageId: otherMessage });
	});
});

describe('dispatch races (Sol r2)', () => {
	const baseline = { category: 'support', disposition: 'reply' };

	it('dispatches exactly the provider it resolved and checked, never a second resolution', async () => {
		mocks.plane.kind = 'local';
		mocks.admitBundle.mockResolvedValue(admitted('advisory'));
		const t = await setup({ categoryDisplayBundle: 'enforce' });
		await enableFeatures(t, ['ai.decisionPlane']);
		const inboundMessageId = await seedTeamMessage(t);
		await t.action(internal.decision.bundleActions.teamMessage, { inboundMessageId, baseline });
		const { resolveDecisionConfig, resolveDecisionProvider } =
			await import('../../lib/decisionProvider');
		expect(vi.mocked(resolveDecisionConfig)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(resolveDecisionProvider)).not.toHaveBeenCalled();
		const options = mocks.runDecision.mock.calls[0]![0] as { provider: { kind: string } };
		expect(options.provider.kind).toBe('local');
	});

	it('sends nothing when the configuration changed after it was resolved (local → hosted)', async () => {
		// The excluded Team Inbox's provider resolved as the local engine from a
		// configuration that is no longer the stored one.
		mocks.plane.kind = 'local';
		mocks.plane.updatedAt = 1;
		mocks.admitBundle.mockResolvedValue(admitted('advisory'));
		const t = await setup({ categoryDisplayBundle: 'enforce' });
		await enableFeatures(t, ['ai.decisionPlane']);
		await t.run(async (ctx) => {
			await ctx.db.insert('agentConfig', {
				isAutoReplyEnabled: false,
				confidenceThreshold: 0.8,
				isExcludedFromHostedDecisions: true,
				createdAt: 1,
				updatedAt: 1,
			});
		});
		const inboundMessageId = await seedTeamMessage(t);
		await t.action(internal.decision.bundleActions.teamMessage, { inboundMessageId, baseline });
		expect(mocks.runDecision).not.toHaveBeenCalled();
		expect(await artifacts(t)).toEqual([]);
	});

	it('never calls once the bundle switches were turned off after the worker planned', async () => {
		mocks.plane.kind = 'typesafe';
		const t = await setup({ categoryDisplayBundle: 'enforce' });
		await enableFeatures(t, ['ai.decisionPlane']);
		// Admission runs between the worker's policy read and its claim: turn
		// every bundle switch off there, as an admin saving the policy would.
		mocks.admitBundle.mockImplementation(async () => {
			await t.run(async (ctx) => {
				const row = await ctx.db.query('aiRoutingPolicy').first();
				await ctx.db.patch(row!._id, {
					categoryDisplayBundle: 'off',
					dispositionAdvisoryBundle: 'off',
					triageBundle: 'off',
					policyVersion: 8,
				});
			});
			return admitted('advisory');
		});
		const inboundMessageId = await seedTeamMessage(t);
		await t.action(internal.decision.bundleActions.teamMessage, {
			inboundMessageId,
			baseline: { category: 'support', disposition: 'reply' },
		});
		expect(mocks.runDecision).not.toHaveBeenCalled();
		expect(await artifacts(t)).toEqual([]);
	});

	it('sends no language call when TypeSafe without a key is configured after resolving to llm (D3)', async () => {
		mocks.plane.kind = 'llm';
		const t = await setup({ triageBundle: 'shadow' });
		await enableFeatures(t, ['ai.decisionPlane']);
		mocks.admitBundle.mockImplementation(async () => {
			await t.run(async (ctx) => {
				await ctx.db.insert('aiProviderConfig', {
					languageProviderKind: 'openai',
					modelFast: 'fast',
					modelCapable: 'capable',
					embeddingProviderKind: 'local',
					embeddingModelVersion: 1,
					decisionProviderKind: 'typesafe',
					updatedAt: Date.now(),
				});
			});
			return admitted();
		});
		const inboundMessageId = await seedTeamMessage(t);
		await t.action(internal.decision.bundleActions.teamTriage, { inboundMessageId });
		expect(mocks.admitBundle).toHaveBeenCalledTimes(1);
		expect(mocks.runLlmObject).not.toHaveBeenCalled();
		expect(await artifacts(t)).toEqual([]);
	});

	it('sends no language call when the decision plane flag moved after resolving', async () => {
		mocks.plane.kind = 'llm';
		const t = await setup({ triageBundle: 'shadow' });
		await enableFeatures(t, ['ai.decisionPlane']);
		mocks.admitBundle.mockImplementation(async () => {
			await t.run(async (ctx) => {
				const settings = await ctx.db.query('instanceSettings').first();
				await ctx.db.patch(settings!._id, {
					featureFlags: { ...settings!.featureFlags, 'ai.decisionPlane': false },
				});
			});
			return admitted();
		});
		const inboundMessageId = await seedTeamMessage(t);
		await t.action(internal.decision.bundleActions.teamTriage, { inboundMessageId });
		expect(mocks.admitBundle).toHaveBeenCalledTimes(1);
		expect(mocks.runLlmObject).not.toHaveBeenCalled();
	});

	it('stops a queued triage job once the master ai flag is turned off', async () => {
		const t = await setup({ triageBundle: 'shadow' });
		const inboundMessageId = await seedTeamMessage(t);
		await t.run(async (ctx) => {
			const settings = await ctx.db.query('instanceSettings').first();
			await ctx.db.patch(settings!._id, { featureFlags: { ...settings!.featureFlags, ai: false } });
		});
		await t.action(internal.decision.bundleActions.teamTriage, { inboundMessageId });
		expect(mocks.runLlmObject).not.toHaveBeenCalled();
		expect(await artifacts(t)).toEqual([]);
	});
});

describe('a corrected message (D12)', () => {
	it('is never judged once the owner corrected it, however late the job runs', async () => {
		const t = await setup({ triageBundle: 'shadow' });
		const inboundMessageId = await seedTeamMessage(t, { decisionCorrectedAt: Date.now() });
		await t.action(internal.decision.bundleActions.teamTriage, { inboundMessageId });
		expect(mocks.runLlmObject).not.toHaveBeenCalled();
		expect(await artifacts(t)).toEqual([]);
	});
});

describe('the Postbox message bundle', () => {
	async function seedThread(t: T) {
		const mailboxId = await seedMailbox(t, { address: 'me@example.com' });
		await seedFolder(t, mailboxId, 'inbox');
		const messageId = await seedMessage(t, mailboxId, {
			fromAddress: 'news@shop.example',
			subject: 'Our autumn sale',
			textBodyInline: 'Everything is 20% off this week.',
		});
		const threadId = await t.run(async (ctx) => {
			const message = await ctx.db.get(messageId);
			await ctx.db.patch(messageId, { dmarcResult: 'pass' });
			await ctx.db.patch(message!.threadId, {
				latestMessageId: messageId,
				category: { label: 'other', source: 'heuristic', classifiedAt: 1 },
			});
			return message!.threadId;
		});
		return { mailboxId, messageId, threadId };
	}

	it('judges the latest inbound message beside the refinement, and moves nothing (D9)', async () => {
		mocks.plane.kind = 'typesafe';
		mocks.admitBundle.mockResolvedValue(admitted('advisory'));
		const t = await setup({ categoryDisplayBundle: 'enforce' });
		await enableFeatures(t, ['ai.decisionPlane']);
		const { mailboxId, messageId, threadId } = await seedThread(t);
		const before = await t.run(async (ctx) => [
			await ctx.db.get(threadId),
			await ctx.db.get(messageId),
		]);

		await t.action(internal.decision.bundleActions.postboxMessage, {
			threadId,
			expectedLatestMessageId: messageId,
			baseline: { category: 'other' },
		});

		expect(mocks.runDecision).toHaveBeenCalledTimes(1);
		const state = (mocks.runDecision.mock.calls[0]![0] as { state: Record<string, unknown> }).state;
		expect(state).toMatchObject({
			mailbox: 'personal mailbox',
			from: 'news@shop.example',
			subject: 'Our autumn sale',
			body: 'Everything is 20% off this week.',
			senderKnown: false,
		});
		const [artifact] = await artifacts(t);
		expect(artifact).toMatchObject({
			task: 'mail.category',
			kind: 'advisory',
			subjectKind: 'mail_message',
			mailMessageId: messageId,
			mailboxId,
			provenance: { questionSetId: 'mail.message.postbox' },
		});
		const after = await t.run(async (ctx) => [
			await ctx.db.get(threadId),
			await ctx.db.get(messageId),
		]);
		expect(after).toEqual(before);
	});

	it('skips a thread a newer message arrived on since the classifier ran', async () => {
		mocks.plane.kind = 'typesafe';
		mocks.admitBundle.mockResolvedValue(admitted('advisory'));
		const t = await setup({ categoryDisplayBundle: 'enforce' });
		await enableFeatures(t, ['ai.decisionPlane']);
		const { mailboxId, threadId } = await seedThread(t);
		const older = await seedMessage(t, mailboxId, { subject: 'older' });
		await t.action(internal.decision.bundleActions.postboxMessage, {
			threadId,
			expectedLatestMessageId: older,
			baseline: { category: 'other' },
		});
		expect(mocks.runDecision).not.toHaveBeenCalled();
	});
});
