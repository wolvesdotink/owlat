/**
 * The previous release's autonomy paths (`autonomy:*`, `autonomyFeedback:*`,
 * `autonomySuggestions:*`, `autonomyOutcome:*`) keep working against this
 * release: each old path returns what its moved function returns, writes what
 * it writes, and keeps its auth floor with the message it used before.
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

describe('previous-release autonomy paths', () => {
	it('rule reads and writes through autonomy:* match autonomy/policy', async () => {
		const t = await harness();
		const user = t.withIdentity(identity);

		const ruleId = await user.mutation(api.autonomy.upsertRule, {
			category: 'support',
			autoApproveThreshold: 0.8,
			maxDailyAutoActions: 2,
			isEnabled: true,
		});
		const senderRuleId = await user.mutation(api.autonomy.setSenderAutonomy, {
			category: 'support',
			sender: 'Pat <pat@example.com>',
			isEnabled: false,
		});

		const oldList = await user.query(api.autonomy.listRules, {});
		expect(oldList).toEqual(await user.query(api.autonomy.policy.listRules, {}));
		expect(oldList.map((rule) => rule._id).sort()).toEqual([ruleId, senderRuleId].sort());
		expect(await t.query(internal.autonomy.listRulesInternal, {})).toEqual(oldList);

		const decisionArgs = { category: 'support', confidence: 0.9 };
		const oldDecision = await t.query(internal.autonomy.checkPermissionInternal, decisionArgs);
		expect(oldDecision).toEqual(
			await t.query(internal.autonomy.policy.checkPermissionInternal, decisionArgs)
		);
		expect(oldDecision).toMatchObject({ mode: 'enabled', allowed: true });

		expect(
			await t.mutation(internal.autonomy.incrementDailyCount, { category: 'support' })
		).toEqual({ allowed: true });
		expect(
			await t.mutation(internal.autonomy.policy.incrementDailyCount, { category: 'support' })
		).toEqual({ allowed: true });
		expect(
			await t.mutation(internal.autonomy.incrementDailyCount, { category: 'support' })
		).toEqual({ allowed: false, reason: 'Daily auto-action limit (2) reached for support' });

		await t.mutation(internal.autonomy.resetDailyCounts, {});
		const reset = await t.run((ctx) => ctx.db.get(ruleId));
		expect(reset?.currentDailyCount).toBe(0);

		await user.mutation(api.autonomy.deleteRule, { ruleId: senderRuleId });
		expect((await user.query(api.autonomy.policy.listRules, {})).map((r) => r._id)).toEqual([
			ruleId,
		]);
	});

	it('feedback through autonomyFeedback:* matches autonomy/feedback', async () => {
		const t = await harness();
		const user = t.withIdentity(identity);
		await t.run((ctx) =>
			ctx.db.insert('autonomyRules', createTestAutonomyRule({ autoApproveThreshold: 0.5 }))
		);

		for (let i = 0; i < 5; i++) {
			await t.mutation(internal.autonomyFeedback.recordFeedback, {
				category: 'support',
				action: 'rejected',
				agentConfidence: 0.9,
			});
		}

		const oldStats = await user.query(api.autonomyFeedback.getFeedbackStats, {});
		expect(oldStats).toEqual(await user.query(api.autonomy.feedback.getFeedbackStats, {}));
		expect(oldStats).toEqual({ support: { approved: 0, rejected: 5, edited: 0 } });

		const countArgs = { since: 0 };
		const oldCounts = await t.query(internal.autonomyFeedback.getFeedbackCountsInternal, countArgs);
		expect(oldCounts).toEqual(
			await t.query(internal.autonomy.feedback.getFeedbackCountsInternal, countArgs)
		);
		expect(oldCounts).toEqual({ approved: 0, rejected: 5, edited: 0, total: 5 });

		const recentArgs = { category: 'support', limit: 3 };
		const oldRecent = await t.query(
			internal.autonomyFeedback.getRecentFeedbackInternal,
			recentArgs
		);
		expect(oldRecent).toEqual(
			await t.query(internal.autonomy.feedback.getRecentFeedbackInternal, recentArgs)
		);
		expect(oldRecent).toHaveLength(3);

		// Five rejections out of five tighten the threshold by 0.1.
		await t.action(internal.autonomyFeedback.adjustThresholds, {});
		const [rule] = await t.run((ctx) => ctx.db.query('autonomyRules').collect());
		expect(rule?.autoApproveThreshold).toBeCloseTo(0.6);
	});

	it('suggestions through autonomySuggestions:* match autonomy/suggestions', async () => {
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

		const oldList = await user.query(api.autonomySuggestions.listGraduationSuggestions, {});
		expect(oldList).toEqual(
			await user.query(api.autonomy.suggestions.listGraduationSuggestions, {})
		);
		expect(oldList.map((s) => s._id)).toEqual([suggestionId]);

		await user.mutation(api.autonomySuggestions.acceptGraduationSuggestion, { suggestionId });
		expect((await t.run((ctx) => ctx.db.get(ruleId)))?.autoApproveThreshold).toBe(0.8);
		expect(await user.query(api.autonomy.suggestions.listGraduationSuggestions, {})).toEqual([]);
	});

	it('outcomes through autonomyOutcome:* match autonomy/outcome', async () => {
		const t = await harness();
		const user = t.withIdentity(identity);
		const { originalId, replyId } = await seedAutoSentThread(t, 'Pat <pat@example.com>');

		const replyArgs = { replyMessageId: replyId };
		const oldContext = await t.query(internal.autonomyOutcome.getReplyOutcomeContext, replyArgs);
		expect(oldContext).toEqual(
			await t.query(internal.autonomy.outcome.getReplyOutcomeContext, replyArgs)
		);
		expect(oldContext).toMatchObject({ wasAutoSent: true, originalMessageId: originalId });

		await t.mutation(internal.autonomyOutcome.recordOutcomeFeedback, {
			inboundMessageId: originalId,
			signal: 'bounce',
		});
		const feedback = await t.run((ctx) => ctx.db.query('autonomyFeedback').collect());
		expect(feedback.map((f) => [f.action, f.source, f.outcomeSignal])).toEqual([
			['rejected', 'outcome', 'bounce'],
		]);

		const oldIncidents = await user.query(api.autonomyOutcome.listAutoDemotions, {});
		expect(oldIncidents).toEqual(await user.query(api.autonomy.outcome.listAutoDemotions, {}));
		expect(oldIncidents).toMatchObject([{ category: 'support', sender: 'pat@example.com' }]);

		await user.mutation(api.autonomyOutcome.acknowledgeAutoDemotion, {
			ruleId: oldIncidents[0]!._id as Id<'autonomyRules'>,
		});
		expect(await user.query(api.autonomy.outcome.listAutoDemotions, {})).toEqual([]);
		const audit = await t.run((ctx) => ctx.db.query('auditLogs').collect());
		expect(audit.map((row) => [row.action, row.userId])).toEqual([
			['agent.demotion_acknowledged', 'test-user'],
		]);
	});

	it('keep the owner/admin floor on every old public path', async () => {
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
			user.mutation(api.autonomy.upsertRule, {
				category: 'support',
				autoApproveThreshold: 0.5,
				maxDailyAutoActions: 10,
				isEnabled: true,
			})
		).rejects.toThrow(rules);
		await expect(
			user.mutation(api.autonomy.setSenderAutonomy, {
				category: 'support',
				sender: 'pat@example.com',
				isEnabled: true,
			})
		).rejects.toThrow(rules);
		await expect(user.mutation(api.autonomy.deleteRule, { ruleId })).rejects.toThrow(
			'Only owners and admins can delete autonomy rules'
		);
		await expect(
			user.mutation(api.autonomySuggestions.acceptGraduationSuggestion, { suggestionId })
		).rejects.toThrow('Only owners and admins can widen autonomy');
		await expect(
			user.mutation(api.autonomyOutcome.acknowledgeAutoDemotion, { ruleId })
		).rejects.toThrow('Only owners and admins can manage autonomy');

		const denied = "You don't have permission to perform this action";
		await expect(user.query(api.autonomy.listRules, {})).rejects.toThrow(denied);
		await expect(user.query(api.autonomyFeedback.getFeedbackStats, {})).rejects.toThrow(denied);
		await expect(user.query(api.autonomySuggestions.listGraduationSuggestions, {})).rejects.toThrow(
			denied
		);
		await expect(user.query(api.autonomyOutcome.listAutoDemotions, {})).rejects.toThrow(denied);

		const unchanged = await t.run((ctx) => ctx.db.get(ruleId));
		expect(unchanged?.autoApproveThreshold).toBe(0.85);
		expect(await t.run((ctx) => ctx.db.get(suggestionId))).not.toBeNull();
	});
});
