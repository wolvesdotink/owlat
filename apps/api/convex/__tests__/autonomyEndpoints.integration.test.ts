/**
 * The autonomy endpoints (`autonomy/policy`, `autonomy/feedback`,
 * `autonomy/suggestions`, `autonomy/outcome`): what each returns and writes,
 * and the auth floor each keeps with its refusal message.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { OrganizationRole } from '../lib/sessionOrganization';
import type * as SessionOrganizationModule from '../lib/sessionOrganization';
import {
	createTestAutonomyRule,
	createTestConversationThread,
	createTestInboundMessage,
	enableFeatures,
} from './factories';

let mockRole: OrganizationRole = 'owner';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganizationModule>(
		'../lib/sessionOrganization'
	);
	const session = () => ({ userId: 'test-user', role: mockRole });
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn(async () => session()),
		// The adminQuery floor: owner/admin pass `organization:manage`, editor does not.
		requireOrgPermission: vi.fn(async () => {
			if (mockRole === 'editor')
				throw new Error("You don't have permission to perform this action");
			return session();
		}),
	};
});

vi.mock('../lib/posthogHelpers', async () => ({
	trackEvent: vi.fn().mockResolvedValue(undefined),
}));

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

const identity = {
	subject: 'test-user',
	issuer: 'https://test.issuer.com',
	tokenIdentifier: 'https://test.issuer.com|test-user',
};

type T = ReturnType<typeof convexTest>;

async function harness(): Promise<T> {
	const t = convexTest(schema, modules);
	await enableFeatures(t, ['ai.autonomy']);
	return t;
}

/** An auto-sent original on a thread and a later reply to it. */
async function seedAutoSentThread(t: T, from: string) {
	return await t.run(async (ctx) => {
		// The factory also emits `channel`/`updatedAt`, which the
		// conversationThreads table does not have.
		const {
			channel: _channel,
			updatedAt: _updatedAt,
			...thread
		} = createTestConversationThread({ contactId: undefined });
		const threadId = await ctx.db.insert('conversationThreads', thread as never);
		const originalId = await ctx.db.insert('inboundMessages', {
			...createTestInboundMessage({
				threadId,
				contactId: undefined,
				from,
				processingStatus: 'sent',
				receivedAt: 1_000,
				confidenceScore: 0.95,
				classification: {
					category: 'support',
					priority: 'normal',
					sentiment: 'neutral',
					intent: 'question',
					confidence: 0.95,
				},
				agentDecision: { decision: 'auto_approve', reason: 'confident', confidence: 0.95 },
			}),
		} as never);
		const replyId = await ctx.db.insert('inboundMessages', {
			...createTestInboundMessage({ threadId, contactId: undefined, from, receivedAt: 2_000 }),
		} as never);
		return { originalId, replyId };
	});
}

beforeEach(() => {
	mockRole = 'owner';
});

describe('autonomy endpoints', () => {
	it('rule reads and writes, the decision, the daily cap and its reset', async () => {
		const t = await harness();
		const user = t.withIdentity(identity);

		const ruleId = await user.mutation(api.autonomy.policy.upsertRule, {
			category: 'support',
			autoApproveThreshold: 0.8,
			maxDailyAutoActions: 2,
			isEnabled: true,
		});
		const senderRuleId = await user.mutation(api.autonomy.policy.setSenderAutonomy, {
			category: 'support',
			sender: 'Pat <pat@example.com>',
			isEnabled: false,
		});

		const list = await user.query(api.autonomy.policy.listRules, {});
		expect(list.map((rule) => rule._id).sort()).toEqual([ruleId, senderRuleId].sort());
		expect(await t.query(internal.autonomy.policy.listRulesInternal, {})).toEqual(list);

		const decisionArgs = { category: 'support', confidence: 0.9 };
		expect(
			await t.query(internal.autonomy.policy.checkPermissionInternal, decisionArgs)
		).toMatchObject({ mode: 'enabled', allowed: true });

		expect(
			await t.mutation(internal.autonomy.policy.incrementDailyCount, { category: 'support' })
		).toEqual({ allowed: true });
		expect(
			await t.mutation(internal.autonomy.policy.incrementDailyCount, { category: 'support' })
		).toEqual({ allowed: true });
		expect(
			await t.mutation(internal.autonomy.policy.incrementDailyCount, { category: 'support' })
		).toEqual({ allowed: false, reason: 'Daily auto-action limit (2) reached for support' });

		await t.mutation(internal.autonomy.policy.resetDailyCounts, {});
		const reset = await t.run((ctx) => ctx.db.get(ruleId));
		expect(reset?.currentDailyCount).toBe(0);

		await user.mutation(api.autonomy.policy.deleteRule, { ruleId: senderRuleId });
		expect((await user.query(api.autonomy.policy.listRules, {})).map((r) => r._id)).toEqual([
			ruleId,
		]);
	});

	it('feedback reads count what was recorded, and five rejections tighten the threshold', async () => {
		const t = await harness();
		const user = t.withIdentity(identity);
		await t.run((ctx) =>
			ctx.db.insert('autonomyRules', createTestAutonomyRule({ autoApproveThreshold: 0.5 }))
		);

		for (let i = 0; i < 5; i++) {
			await t.mutation(internal.autonomy.feedback.recordFeedback, {
				category: 'support',
				action: 'rejected',
				agentConfidence: 0.9,
			});
		}

		expect(await user.query(api.autonomy.feedback.getFeedbackStats, {})).toEqual({
			support: { approved: 0, rejected: 5, edited: 0 },
		});

		expect(
			await t.query(internal.autonomy.feedback.getFeedbackCountsInternal, { since: 0 })
		).toEqual({ approved: 0, rejected: 5, edited: 0, total: 5 });

		expect(
			await t.query(internal.autonomy.feedback.getRecentFeedbackInternal, {
				category: 'support',
				limit: 3,
			})
		).toHaveLength(3);

		// Five rejections out of five tighten the threshold by 0.1.
		await t.action(internal.autonomy.feedback.adjustThresholds, {});
		const [rule] = await t.run((ctx) => ctx.db.query('autonomyRules').collect());
		expect(rule?.autoApproveThreshold).toBeCloseTo(0.6);
	});

	it('accepting a graduation suggestion moves the threshold and clears the suggestion', async () => {
		const t = await harness();
		const user = t.withIdentity(identity);
		const ruleId = await t.run((ctx) =>
			ctx.db.insert('autonomyRules', createTestAutonomyRule({ autoApproveThreshold: 0.9 }))
		);
		const suggestionId = await t.run((ctx) =>
			ctx.db.insert('autonomySuggestions', {
				category: 'support',
				currentThreshold: 0.9,
				suggestedThreshold: 0.8,
				evidence: { approved: 20, sampleSize: 20, rejectionRate: 0 },
				createdAt: 1_000,
			})
		);

		const suggestions = await user.query(api.autonomy.suggestions.listGraduationSuggestions, {});
		expect(suggestions.map((s) => s._id)).toEqual([suggestionId]);

		await user.mutation(api.autonomy.suggestions.acceptGraduationSuggestion, { suggestionId });
		expect((await t.run((ctx) => ctx.db.get(ruleId)))?.autoApproveThreshold).toBe(0.8);
		expect(await user.query(api.autonomy.suggestions.listGraduationSuggestions, {})).toEqual([]);
	});

	it('an outcome on an auto-sent reply records feedback and a demotion an owner acknowledges', async () => {
		const t = await harness();
		const user = t.withIdentity(identity);
		const { originalId, replyId } = await seedAutoSentThread(t, 'Pat <pat@example.com>');

		expect(
			await t.query(internal.autonomy.outcome.getReplyOutcomeContext, { replyMessageId: replyId })
		).toMatchObject({ wasAutoSent: true, originalMessageId: originalId });

		await t.mutation(internal.autonomy.outcome.recordOutcomeFeedback, {
			inboundMessageId: originalId,
			signal: 'bounce',
		});
		const feedback = await t.run((ctx) => ctx.db.query('autonomyFeedback').collect());
		expect(feedback.map((f) => [f.action, f.source, f.outcomeSignal])).toEqual([
			['rejected', 'outcome', 'bounce'],
		]);

		const incidents = await user.query(api.autonomy.outcome.listAutoDemotions, {});
		expect(incidents).toMatchObject([{ category: 'support', sender: 'pat@example.com' }]);

		await user.mutation(api.autonomy.outcome.acknowledgeAutoDemotion, {
			ruleId: incidents[0]!._id as Id<'autonomyRules'>,
		});
		expect(await user.query(api.autonomy.outcome.listAutoDemotions, {})).toEqual([]);
		const audit = await t.run((ctx) => ctx.db.query('auditLogs').collect());
		expect(audit.map((row) => [row.action, row.userId])).toEqual([
			['agent.demotion_acknowledged', 'test-user'],
		]);
	});

	it('keep the owner/admin floor on every public endpoint', async () => {
		const t = await harness();
		const user = t.withIdentity(identity);
		const ruleId = await t.run((ctx) => ctx.db.insert('autonomyRules', createTestAutonomyRule()));
		const suggestionId = await t.run((ctx) =>
			ctx.db.insert('autonomySuggestions', {
				category: 'support',
				currentThreshold: 0.9,
				suggestedThreshold: 0.8,
				evidence: { approved: 20, sampleSize: 20, rejectionRate: 0 },
				createdAt: 1_000,
			})
		);

		mockRole = 'editor';
		const rules = 'Only owners and admins can change autonomy rules';
		await expect(
			user.mutation(api.autonomy.policy.upsertRule, {
				category: 'support',
				autoApproveThreshold: 0.5,
				maxDailyAutoActions: 10,
				isEnabled: true,
			})
		).rejects.toThrow(rules);
		await expect(
			user.mutation(api.autonomy.policy.setSenderAutonomy, {
				category: 'support',
				sender: 'pat@example.com',
				isEnabled: true,
			})
		).rejects.toThrow(rules);
		await expect(user.mutation(api.autonomy.policy.deleteRule, { ruleId })).rejects.toThrow(
			'Only owners and admins can delete autonomy rules'
		);
		await expect(
			user.mutation(api.autonomy.suggestions.acceptGraduationSuggestion, { suggestionId })
		).rejects.toThrow('Only owners and admins can widen autonomy');
		await expect(
			user.mutation(api.autonomy.outcome.acknowledgeAutoDemotion, { ruleId })
		).rejects.toThrow('Only owners and admins can manage autonomy');

		const denied = "You don't have permission to perform this action";
		await expect(user.query(api.autonomy.policy.listRules, {})).rejects.toThrow(denied);
		await expect(user.query(api.autonomy.feedback.getFeedbackStats, {})).rejects.toThrow(denied);
		await expect(
			user.query(api.autonomy.suggestions.listGraduationSuggestions, {})
		).rejects.toThrow(denied);
		await expect(user.query(api.autonomy.outcome.listAutoDemotions, {})).rejects.toThrow(denied);

		const unchanged = await t.run((ctx) => ctx.db.get(ruleId));
		expect(unchanged?.autoApproveThreshold).toBe(0.85);
		expect(await t.run((ctx) => ctx.db.get(suggestionId))).not.toBeNull();
	});
});
