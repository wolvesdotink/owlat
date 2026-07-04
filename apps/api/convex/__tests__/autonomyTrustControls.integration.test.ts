/**
 * Autonomy trust controls (feat: graduation nudge, kill switch, auto-demotion).
 *
 * Covers the server-side behaviour behind the settings UI:
 *   - a confirmed BAD auto-send outcome auto-demotes that sender/category to
 *     draft-only (a disabled per-sender rule) and surfaces a first-class
 *     incident via listAutoDemotions; a GOOD outcome never demotes;
 *   - the one-click kill switch disables the ai.autonomy flag, forces the
 *     legacy auto-reply toggle off, and cancels an in-flight delayed auto-send;
 *   - the graduation suggestion only widens the live threshold on EXPLICIT
 *     accept — recording a suggestion never changes the rule.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	createTestAutonomyRule,
	createTestInboundMessage,
	createTestConversationThread,
	enableFeatures,
} from './factories';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireAdminContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireAuthenticatedIdentity: vi.fn().mockResolvedValue({
			subject: 'test-user',
			issuer: 'test',
			tokenIdentifier: 'test|test-user',
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
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

/** Seed an auto-sent message from a known sender on a fresh thread. */
async function seedAutoSent(
	t: ReturnType<typeof convexTest>,
	opts: { category: string; from: string }
): Promise<Id<'inboundMessages'>> {
	return await t.run(async (ctx) => {
		const {
			channel: _channel,
			updatedAt: _updatedAt,
			...threadDoc
		} = createTestConversationThread({ contactId: undefined });
		const threadId = await ctx.db.insert('conversationThreads', threadDoc as never);
		return await ctx.db.insert('inboundMessages', {
			...createTestInboundMessage({
				threadId,
				contactId: undefined,
				from: opts.from,
				processingStatus: 'sent',
				confidenceScore: 0.9,
				classification: {
					category: opts.category,
					priority: 'normal',
					sentiment: 'neutral',
					intent: 'question',
					confidence: 0.9,
				},
				agentDecision: { decision: 'auto_approve', reason: 'confident', confidence: 0.9 },
			}),
		} as never);
	});
}

// ============================================================
// (4) Auto-demotion on a confirmed bad outcome
// ============================================================

describe('autonomyOutcome — auto-demotion on a bad outcome', () => {
	it('demotes the sender/category to draft-only after a bad auto-send outcome', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.autonomy']);
		const originalId = await seedAutoSent(t, { category: 'support', from: 'angry@example.com' });

		await t.mutation(internal.autonomyOutcome.recordOutcomeFeedback, {
			inboundMessageId: originalId,
			signal: 'complaint',
		});

		// A disabled per-sender rule now exists carrying the incident markers.
		const rule = await t.run(async (ctx) => {
			const rows = await ctx.db.query('autonomyRules').collect();
			return rows.find((r) => r.sender === 'angry@example.com' && r.category === 'support');
		});
		expect(rule).toBeDefined();
		expect(rule!.isEnabled).toBe(false);
		expect(rule!.autoDemotedAt).toBeTypeOf('number');
		expect(rule!.autoDemotedSignal).toBe('complaint');

		// And it surfaces as a first-class incident for the UI.
		const incidents = await t.query(api.autonomyOutcome.listAutoDemotions);
		expect(incidents).toHaveLength(1);
		expect(incidents[0]).toMatchObject({ sender: 'angry@example.com', category: 'support' });
	});

	it('disables a previously-enabled per-sender rule on a bad outcome', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.autonomy']);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'autonomyRules',
				createTestAutonomyRule({
					category: 'support',
					sender: 'angry@example.com',
					isEnabled: true,
				}) as never
			);
		});
		const originalId = await seedAutoSent(t, { category: 'support', from: 'angry@example.com' });

		await t.mutation(internal.autonomyOutcome.recordOutcomeFeedback, {
			inboundMessageId: originalId,
			signal: 'reply_negative',
		});

		const rule = await t.run(async (ctx) => {
			const rows = await ctx.db
				.query('autonomyRules')
				.withIndex('by_sender_category', (q) =>
					q.eq('sender', 'angry@example.com').eq('category', 'support')
				)
				.collect();
			return rows[0];
		});
		expect(rule!.isEnabled).toBe(false);
		expect(rule!.autoDemotedSignal).toBe('reply_negative');
	});

	it('does NOT demote on a GOOD outcome (unedited clarification send)', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.autonomy']);
		const originalId = await seedAutoSent(t, { category: 'sales', from: 'happy@example.com' });

		await t.mutation(internal.autonomyOutcome.recordOutcomeFeedback, {
			inboundMessageId: originalId,
			signal: 'clarification_unedited_send',
		});

		const incidents = await t.query(api.autonomyOutcome.listAutoDemotions);
		expect(incidents).toHaveLength(0);
	});

	it('acknowledge clears the alert but leaves the sender draft-only', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.autonomy']);
		const originalId = await seedAutoSent(t, { category: 'support', from: 'angry@example.com' });
		await t.mutation(internal.autonomyOutcome.recordOutcomeFeedback, {
			inboundMessageId: originalId,
			signal: 'bounce',
		});

		const incidents = await t.query(api.autonomyOutcome.listAutoDemotions);
		expect(incidents).toHaveLength(1);
		await t.mutation(api.autonomyOutcome.acknowledgeAutoDemotion, {
			ruleId: incidents[0]!._id as Id<'autonomyRules'>,
		});

		// Alert gone …
		expect(await t.query(api.autonomyOutcome.listAutoDemotions)).toHaveLength(0);
		// … but the rule is still disabled (draft-only).
		const rule = await t.run(async (ctx) => ctx.db.get(incidents[0]!._id as Id<'autonomyRules'>));
		expect(rule!.isEnabled).toBe(false);
	});
});

// ============================================================
// (2) One-click kill switch
// ============================================================

describe('agentConfigMutations.killSwitch', () => {
	it('halts future + in-flight auto-sends and reverts to draft-only', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.autonomy']); // ai.autonomy (+ ai, ai.agent) on

		// Legacy global auto-reply is also ON.
		await t.run(async (ctx) => {
			await ctx.db.insert('agentConfig', {
				isAutoReplyEnabled: true,
				confidenceThreshold: 0.8,
				maxDailyAutoReplies: 100,
				coalesceWindowMs: 30000,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		// An autonomous send is sitting in its undo window.
		const messageId = await t.run(async (ctx) => {
			const {
				channel: _channel,
				updatedAt: _updatedAt,
				...threadDoc
			} = createTestConversationThread({ contactId: undefined });
			const threadId = await ctx.db.insert('conversationThreads', threadDoc as never);
			const id = await ctx.db.insert('inboundMessages', {
				...createTestInboundMessage({
					threadId,
					contactId: undefined,
					processingStatus: 'approved',
					draftResponse: 'Auto reply',
				}),
			} as never);
			const scheduledFnId = await ctx.scheduler.runAfter(
				60_000,
				internal.agent.agentPipeline.sendApprovedReply,
				{ inboundMessageId: id, autonomous: true }
			);
			await ctx.db.patch(id, {
				pendingAutoSend: { scheduledFnId, sendAt: Date.now() + 60_000, scheduledAt: Date.now() },
			});
			return id;
		});

		// killSwitch schedules the bulk-cancel via runAfter(0); that scheduled
		// mutation only fires on a macrotask, so drain it under fake timers.
		// Advance by a single millisecond per pump so ONLY the due-now cancel
		// fires — never the 60s-out sendApprovedReply (which stays queued and is
		// then cancelled, not run).
		vi.useFakeTimers();
		try {
			await t.mutation(api.agentConfigMutations.killSwitch, {});
			await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1));
		} finally {
			vi.useRealTimers();
		}

		// Feature flag off …
		const flags = await t.run(async (ctx) => {
			const s = await ctx.db.query('instanceSettings').first();
			return s?.featureFlags as Record<string, boolean> | undefined;
		});
		expect(flags?.['ai.autonomy']).toBe(false);

		// … legacy toggle off …
		const cfg = await t.run(async (ctx) => (await ctx.db.query('agentConfig').take(1))[0]);
		expect(cfg!.isAutoReplyEnabled).toBe(false);

		// … and the in-flight send was pulled back to human review.
		const msg = await t.run(async (ctx) => ctx.db.get(messageId));
		expect(msg!.processingStatus).toBe('draft_ready');
		expect(msg!.pendingAutoSend).toBeUndefined();
	});
});

// ============================================================
// (1) Graduation only widens on explicit accept
// ============================================================

describe('graduation nudge — explicit accept only', () => {
	it('recording a suggestion does NOT change the live threshold; accept does', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['ai.autonomy']);

		const ruleId = await t.run(async (ctx) =>
			ctx.db.insert(
				'autonomyRules',
				createTestAutonomyRule({ category: 'support', autoApproveThreshold: 0.9 }) as never
			)
		);

		// The weekly cron records a loosening suggestion — the live rule is untouched.
		await t.mutation(internal.autonomySuggestions.recordGraduationSuggestion, {
			category: 'support',
			currentThreshold: 0.9,
			suggestedThreshold: 0.7,
			evidence: { approved: 20, sampleSize: 20, rejectionRate: 0 },
		});
		let rule = await t.run(async (ctx) => ctx.db.get(ruleId));
		expect(rule!.autoApproveThreshold).toBe(0.9); // unchanged — no silent widening

		// Explicit accept applies the looser threshold and clears the suggestion.
		const suggestion = await t.query(api.autonomySuggestions.listGraduationSuggestions);
		expect(suggestion).toHaveLength(1);
		await t.mutation(api.autonomySuggestions.acceptGraduationSuggestion, {
			suggestionId: suggestion[0]!._id as Id<'autonomySuggestions'>,
		});

		rule = await t.run(async (ctx) => ctx.db.get(ruleId));
		expect(rule!.autoApproveThreshold).toBe(0.7);
		expect(await t.query(api.autonomySuggestions.listGraduationSuggestions)).toHaveLength(0);
	});
});
