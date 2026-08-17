/**
 * Undo window for HUMAN approvals (adoption-gaps piece C1, decision D5).
 *
 * A human Approve now schedules its send behind
 * `agentConfig.humanApproveUndoDelayMs` (default 15s, clamped 0–120s),
 * persisting the SAME cancellable `pendingAutoSend` marker the autonomous
 * path uses — so `undoAutoSend` pulls the reply back to `draft_ready`
 * through one shared code path. Covers:
 *   - the delayed send is scheduled at the window and armed to fire,
 *   - undo within the window cancels the scheduled fn + restores draft_ready,
 *   - undo after the window is a clean no-op,
 *   - delayMs 0 is byte-identical to the legacy immediate human send,
 *   - the autonomous path is untouched by the new config,
 *   - the reconcile cron tolerates human-origin pendingAutoSend markers,
 *   - default / clamp behaviour of the config resolution.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import {
	clampHumanApproveUndoDelayMs,
	DEFAULT_HUMAN_APPROVE_UNDO_DELAY_MS,
	MAX_HUMAN_APPROVE_UNDO_DELAY_MS,
	resolveHumanApproveUndoDelayMs,
} from '../processingLifecycle/effects';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'reviewer-1', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('reviewer-1'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'reviewer-1', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'reviewer-1', role: 'owner' }),
		requireAdminContext: vi.fn().mockResolvedValue({ userId: 'reviewer-1', role: 'owner' }),
	};
});

// See receiveMessageAuth.test.ts: the `../../**` glob omits the `inbox/` dir it
// climbed through, so merge a second glob rooted at `inbox/` and re-prefix its keys.
const rootGlob = import.meta.glob('../../**/*.*s');
const inboxGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../inbox/'),
		mod,
	])
);
const allModules = { ...rootGlob, ...inboxGlob };
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

async function setAgentConfig(
	t: ReturnType<typeof convexTest>,
	overrides: Record<string, unknown> = {}
) {
	await t.run(async (ctx) => {
		await ctx.db.insert('agentConfig', {
			isAutoReplyEnabled: true,
			confidenceThreshold: 0.8,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			...overrides,
		});
	});
}

async function createThread(t: ReturnType<typeof convexTest>): Promise<Id<'conversationThreads'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert('conversationThreads', {
			subject: 'Help please',
			normalizedSubject: 'help please',
			contactIdentifier: 'sender@example.com',
			status: 'open',
			messageCount: 1,
			lastMessageAt: now,
			firstMessageAt: now,
			createdAt: now,
		});
	});
}

async function createDraftReadyMessage(
	t: ReturnType<typeof convexTest>,
	overrides: Record<string, unknown> = {}
): Promise<Id<'inboundMessages'>> {
	return await t.run(async (ctx) => {
		return await ctx.db.insert('inboundMessages', {
			messageId: `msg-${Math.random().toString(36).slice(2)}`,
			from: 'sender@example.com',
			to: 'support@owlat.app',
			subject: 'Help please',
			textBody: 'I need help',
			processingStatus: 'draft_ready',
			draftResponse: 'Thanks for reaching out',
			receivedAt: Date.now(),
			...overrides,
		});
	});
}

/** Narrow an approve result past its collision arm to reach `undo`. */
function approveSuccess(result: { success: boolean }): {
	success: true;
	undo?: { sendAt: number };
} {
	if (!result.success) throw new Error('expected a successful approve');
	return result as { success: true; undo?: { sendAt: number } };
}

/** The agent-pipeline send jobs scheduled for one message. */
async function sendJobsFor(t: ReturnType<typeof convexTest>, messageId: Id<'inboundMessages'>) {
	return t.run(async (ctx) => {
		const scheduled = await ctx.db.system.query('_scheduled_functions').collect();
		return scheduled.filter(
			(j) =>
				j.name.includes('agent/agentPipeline') &&
				(j.args[0] as { inboundMessageId?: Id<'inboundMessages'> })?.inboundMessageId === messageId
		);
	});
}

// ============================================================
// approveDraft — delayed human send + marker
// ============================================================

describe('approveDraft — human undo window', () => {
	it('schedules the send at the configured window, arms the marker, and returns sendAt', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 20_000 });
		const threadId = await createThread(t);
		const messageId = await createDraftReadyMessage(t, { threadId });

		const before = Date.now();
		const result = await t.mutation(api.inbox.mutations.approveDraft, {
			inboundMessageId: messageId,
		});

		expect(result.success).toBe(true);
		expect(approveSuccess(result).undo?.sendAt).toBeGreaterThanOrEqual(before + 20_000 - 1_000);

		// The delayed send is armed to fire at the window, flagged non-autonomous.
		const jobs = await sendJobsFor(t, messageId);
		expect(jobs.length).toBe(1);
		expect(jobs[0]!.state.kind).toBe('pending');
		expect(jobs[0]!.scheduledTime).toBeGreaterThanOrEqual(before + 20_000 - 1_000);
		expect((jobs[0]!.args[0] as { autonomous?: boolean }).autonomous).toBe(false);

		// The same cancellable marker the autonomous path uses is persisted.
		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.processingStatus).toBe('approved');
			expect(m?.pendingAutoSend?.scheduledFnId).toBeDefined();
			expect(m?.pendingAutoSend?.sendAt).toBeGreaterThanOrEqual(before + 20_000 - 1_000);
			const thread = await ctx.db.get(threadId);
			expect(thread?.latestDraftStatus).toBe('approved');
		});
	});

	it('defaults to the 15s window when humanApproveUndoDelayMs is unset', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t); // no humanApproveUndoDelayMs
		const messageId = await createDraftReadyMessage(t);

		const before = Date.now();
		const result = await t.mutation(api.inbox.mutations.approveDraft, {
			inboundMessageId: messageId,
		});

		expect(approveSuccess(result).undo?.sendAt).toBeGreaterThanOrEqual(before + 15_000 - 1_000);
		const jobs = await sendJobsFor(t, messageId);
		expect(jobs.length).toBe(1);
		expect(jobs[0]!.scheduledTime).toBeGreaterThanOrEqual(before + 15_000 - 1_000);
		expect(jobs[0]!.scheduledTime).toBeLessThan(before + 60_000);
	});

	it('applies the default window even with NO agentConfig row at all', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createDraftReadyMessage(t);

		const before = Date.now();
		const result = await t.mutation(api.inbox.mutations.approveDraft, {
			inboundMessageId: messageId,
		});

		expect(approveSuccess(result).undo?.sendAt).toBeGreaterThanOrEqual(before + 15_000 - 1_000);
		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.pendingAutoSend).toBeDefined();
		});
	});

	it('delayMs 0 is byte-identical to the legacy immediate human send', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 0 });
		const messageId = await createDraftReadyMessage(t);

		const before = Date.now();
		const result = await t.mutation(api.inbox.mutations.approveDraft, {
			inboundMessageId: messageId,
		});

		// No undo window offered to the caller …
		expect(result.success).toBe(true);
		expect(approveSuccess(result).undo).toBeUndefined();

		// … the send fires immediately, no cancellable marker.
		const jobs = await sendJobsFor(t, messageId);
		expect(jobs.length).toBe(1);
		expect(jobs[0]!.scheduledTime).toBeLessThan(before + 5_000);
		expect((jobs[0]!.args[0] as { autonomous?: boolean }).autonomous).toBe(false);
		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.processingStatus).toBe('approved');
			expect(m?.pendingAutoSend).toBeUndefined();
		});
	});

	it('a lifecycle transition WITHOUT undoDelayMs stays the legacy immediate send', async () => {
		// Direct internal callers (tests, edit→approve fallbacks) that never
		// thread a window keep today's behaviour even when the config sets one —
		// the window is resolved by approveDraft, not inside the lifecycle.
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 60_000 });
		const messageId = await createDraftReadyMessage(t);

		const before = Date.now();
		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: { to: 'approved', at: before, source: 'human', userId: 'reviewer-1' },
		});

		const jobs = await sendJobsFor(t, messageId);
		expect(jobs.length).toBe(1);
		expect(jobs[0]!.scheduledTime).toBeLessThan(before + 5_000);
		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.pendingAutoSend).toBeUndefined();
		});
	});
});

// ============================================================
// undoAutoSend — within / after the window
// ============================================================

describe('undoAutoSend — human approve undo', () => {
	it('undo within the window cancels the scheduled send and restores draft_ready', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 30_000 });
		const threadId = await createThread(t);
		const messageId = await createDraftReadyMessage(t, { threadId });

		await t.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: messageId });

		const result = await t.mutation(api.inbox.mutations.undoAutoSend, {
			inboundMessageId: messageId,
		});
		expect(result.cancelled).toBe(true);

		// The scheduled fn is cancelled — nothing left pending to fire.
		const jobs = await sendJobsFor(t, messageId);
		expect(jobs.filter((j) => j.state.kind === 'pending').length).toBe(0);

		// Back in the review queue, marker cleared, thread projection restored.
		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.processingStatus).toBe('draft_ready');
			expect(m?.pendingAutoSend).toBeUndefined();
			const thread = await ctx.db.get(threadId);
			expect(thread?.latestDraftStatus).toBe('pending');
		});

		// The undo is audited with the explicit user_cancel reason.
		await t.run(async (ctx) => {
			const logs = await ctx.db.query('auditLogs').collect();
			const entry = logs.find((l) => l.action === 'inbound.auto_send_cancelled');
			expect(entry?.userId).toBe('reviewer-1');
			expect((entry?.details as { reason?: string } | undefined)?.reason).toBe('user_cancel');
		});
	});

	it('undo after the window (send already fired) is a clean no-op', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 30_000 });
		const messageId = await createDraftReadyMessage(t);

		await t.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: messageId });

		// Simulate the window elapsing: the scheduled send has left `pending`
		// (fired at its deadline) while the marker is still on the row.
		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			await ctx.scheduler.cancel(m!.pendingAutoSend!.scheduledFnId);
		});

		const result = await t.mutation(api.inbox.mutations.undoAutoSend, {
			inboundMessageId: messageId,
		});
		expect(result.cancelled).toBe(false);
		expect(result.reason).toBe('already_sent');

		// Still on the send path — never bounced back to review.
		await t.run(async (ctx) => {
			const m = await ctx.db.get(messageId);
			expect(m?.processingStatus).toBe('approved');
		});
	});

	it('undo on an immediate (delay 0) approve is a clean no-op', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 0 });
		const messageId = await createDraftReadyMessage(t);

		await t.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: messageId });

		const result = await t.mutation(api.inbox.mutations.undoAutoSend, {
			inboundMessageId: messageId,
		});
		expect(result.cancelled).toBe(false);
		expect(result.reason).toBe('no_pending_send');
	});
});

// ============================================================
// Learning-loop feedback fires at SEND time, not approve time (G3)
// ============================================================

describe('approval feedback records at send-fire time', () => {
	async function feedbackRows(t: ReturnType<typeof convexTest>) {
		return await t.run(
			async (ctx) => await ctx.db.query('autonomyFeedback').collect() // bounded: test data
		);
	}

	it('an approve inside its window records NO feedback, and an undo leaves zero rows', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 30_000 });
		const messageId = await createDraftReadyMessage(t);

		await t.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: messageId });
		// The held send has not fired — the trust signal must not have either.
		expect(await feedbackRows(t)).toHaveLength(0);

		const undone = await t.mutation(api.inbox.mutations.undoAutoSend, {
			inboundMessageId: messageId,
		});
		expect(undone.cancelled).toBe(true);
		// The undone approval trained nothing.
		expect(await feedbackRows(t)).toHaveLength(0);
	});

	it('approve → undo → re-approve records exactly once, when the send actually fires', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 30_000 });
		const messageId = await createDraftReadyMessage(t);

		await t.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: messageId });
		await t.mutation(api.inbox.mutations.undoAutoSend, { inboundMessageId: messageId });
		await t.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: messageId });
		expect(await feedbackRows(t)).toHaveLength(0);

		// The send fires at the window's deadline: sendApprovedReply invokes the
		// send-time recorder once its dispatch succeeds.
		await t.mutation(internal.inbox.decisionFeedback.recordApprovalSignalsAtSend, {
			inboundMessageId: messageId,
		});
		const rows = await feedbackRows(t);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ action: 'approved', inboundMessageId: messageId });

		// Idempotent per message: the stuck-approved reconcile may re-fire
		// sendApprovedReply after a lost completion — no second approval signal.
		await t.mutation(internal.inbox.decisionFeedback.recordApprovalSignalsAtSend, {
			inboundMessageId: messageId,
		});
		expect(await feedbackRows(t)).toHaveLength(1);
	});

	it('the once-per-message guard ignores post-send outcome rows', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 30_000 });
		const messageId = await createDraftReadyMessage(t);

		// A positive outcome signal (source: 'outcome') maps to action 'approved'
		// but is NOT a human approval — it must not suppress the human signal.
		await t.run(async (ctx) => {
			await ctx.db.insert('autonomyFeedback', {
				category: 'other',
				action: 'approved',
				agentConfidence: 0,
				inboundMessageId: messageId,
				source: 'outcome',
				outcomeSignal: 'clarification_unedited_send',
				createdAt: Date.now(),
			});
		});

		await t.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: messageId });
		await t.mutation(internal.inbox.decisionFeedback.recordApprovalSignalsAtSend, {
			inboundMessageId: messageId,
		});

		const rows = await feedbackRows(t);
		expect(rows.filter((r) => r.action === 'approved' && r.source !== 'outcome')).toHaveLength(1);
	});

	it('a reconcile-recovered AUTONOMOUS send records no human approval signal', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createDraftReadyMessage(t, { processingStatus: 'drafting' });

		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: { to: 'approved', at: Date.now(), source: 'auto' },
		});
		// The approved transition persists its provenance on the message.
		const message = await t.run(async (ctx) => await ctx.db.get(messageId));
		expect(message?.approvalSource).toBe('auto');

		// reconcileStuckApproved re-fires sendApprovedReply WITHOUT the
		// `autonomous` arg — the recorder must key on the message's provenance,
		// not the arg, so the recovered autonomous send trains nothing.
		await t.mutation(internal.inbox.decisionFeedback.recordApprovalSignalsAtSend, {
			inboundMessageId: messageId,
		});
		expect(await feedbackRows(t)).toHaveLength(0);
	});

	it('a human approve persists approvalSource human and still records at send time', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 30_000 });
		const messageId = await createDraftReadyMessage(t);

		await t.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: messageId });
		const message = await t.run(async (ctx) => await ctx.db.get(messageId));
		expect(message?.approvalSource).toBe('human');

		await t.mutation(internal.inbox.decisionFeedback.recordApprovalSignalsAtSend, {
			inboundMessageId: messageId,
		});
		expect(await feedbackRows(t)).toHaveLength(1);
	});
});

// ============================================================
// approveDraft — lost race returns an honest non-success
// ============================================================

describe('approveDraft — lost race (illegal edge)', () => {
	it('a second approve (double-click) is a non-success with no undo window and no side effects', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 20_000 });
		const messageId = await createDraftReadyMessage(t);

		const first = await t.mutation(api.inbox.mutations.approveDraft, {
			inboundMessageId: messageId,
		});
		expect(first.success).toBe(true);

		// The row already left `draft_ready` — the `approved → approved` edge is
		// refused, and the mutation must not fabricate a success + undo toast.
		const second = await t.mutation(api.inbox.mutations.approveDraft, {
			inboundMessageId: messageId,
		});
		expect(second).toEqual({ success: false, reason: 'not_found' });

		// No second scheduled send, no second audit row, still zero feedback.
		expect((await sendJobsFor(t, messageId)).length).toBe(1);
		await t.run(async (ctx) => {
			const audits = (await ctx.db.query('auditLogs').collect()).filter(
				(l) => l.action === 'inbound.draft_approved'
			);
			expect(audits).toHaveLength(1);
			expect(await ctx.db.query('autonomyFeedback').collect()).toHaveLength(0);
		});
	});

	it('approving a row a teammate already sent reads as gone (bulk vocabulary)', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 20_000 });
		const messageId = await createDraftReadyMessage(t, { processingStatus: 'sent' });

		const result = await t.mutation(api.inbox.mutations.approveDraft, {
			inboundMessageId: messageId,
		});
		expect(result).toEqual({ success: false, reason: 'not_found' });
		await t.run(async (ctx) => {
			expect((await ctx.db.get(messageId))?.processingStatus).toBe('sent');
			expect(await ctx.db.query('auditLogs').collect()).toHaveLength(0);
		});
	});
});

// ============================================================
// Autonomous path untouched
// ============================================================

describe('autonomous path is untouched by humanApproveUndoDelayMs', () => {
	it('auto-approve still uses autoSendDelayMs (60s default), not the human window', async () => {
		const t = convexTest(schema, modules);
		// A short HUMAN window must not leak into the autonomous schedule.
		await setAgentConfig(t, { humanApproveUndoDelayMs: 5_000 });
		const messageId = await createDraftReadyMessage(t, { processingStatus: 'drafting' });

		const before = Date.now();
		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: messageId,
			input: { to: 'approved', at: before, source: 'auto' },
		});

		const jobs = await sendJobsFor(t, messageId);
		expect(jobs.length).toBe(1);
		expect(jobs[0]!.scheduledTime).toBeGreaterThanOrEqual(before + 60_000 - 1_000);
		expect((jobs[0]!.args[0] as { autonomous?: boolean }).autonomous).toBe(true);
	});
});

// ============================================================
// Reconcile cron tolerates human-origin markers
// ============================================================

describe('reconcileStuckApproved with human-origin pendingAutoSend', () => {
	it('does NOT re-fire a human-approved send still inside its undo window', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 120_000 });
		const messageId = await createDraftReadyMessage(t);

		await t.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: messageId });

		// Even with processedAt forced stale, staleness is measured from the
		// marker's sendAt — a legitimately-delayed human send is never "stuck".
		await t.run(async (ctx) => {
			await ctx.db.patch(messageId, { processedAt: Date.now() - 30 * 60 * 1000 });
		});

		const result = await t.mutation(internal.inbox.processingLifecycle.reconcileStuckApproved, {});
		expect(result.reEnqueued).toBe(0);
		expect((await sendJobsFor(t, messageId)).length).toBe(1); // only the original
	});

	it('DOES recover a human-origin delayed send whose completion was lost', async () => {
		const t = convexTest(schema, modules);
		const messageId = await createDraftReadyMessage(t, {
			processingStatus: 'approved',
			processedAt: Date.now() - 40 * 60 * 1000,
		});
		// Human-origin marker whose sendAt is itself long past the staleness
		// window — the delayed send fired but its completion never landed.
		await t.run(async (ctx) => {
			const scheduledFnId = await ctx.scheduler.runAfter(
				0,
				internal.agent.agentPipeline.sendApprovedReply,
				{ inboundMessageId: messageId, autonomous: false }
			);
			await ctx.db.patch(messageId, {
				pendingAutoSend: {
					scheduledFnId,
					sendAt: Date.now() - 20 * 60 * 1000,
					scheduledAt: Date.now() - 20 * 60 * 1000 - 15_000,
				},
			});
		});

		const result = await t.mutation(internal.inbox.processingLifecycle.reconcileStuckApproved, {});
		expect(result.reEnqueued).toBe(1);
	});
});

// ============================================================
// Config resolution — default + clamp
// ============================================================

describe('resolveHumanApproveUndoDelayMs', () => {
	it('defaults to 15s when unset', () => {
		expect(resolveHumanApproveUndoDelayMs(undefined)).toBe(DEFAULT_HUMAN_APPROVE_UNDO_DELAY_MS);
		expect(DEFAULT_HUMAN_APPROVE_UNDO_DELAY_MS).toBe(15_000);
	});

	it('clamps into [0, 120000]', () => {
		expect(resolveHumanApproveUndoDelayMs(500_000)).toBe(MAX_HUMAN_APPROVE_UNDO_DELAY_MS);
		expect(resolveHumanApproveUndoDelayMs(-5)).toBe(0);
		expect(resolveHumanApproveUndoDelayMs(0)).toBe(0);
		expect(resolveHumanApproveUndoDelayMs(30_000)).toBe(30_000);
	});

	it('falls back to the default on a non-finite configured value', () => {
		expect(clampHumanApproveUndoDelayMs(Number.NaN)).toBe(DEFAULT_HUMAN_APPROVE_UNDO_DELAY_MS);
		expect(clampHumanApproveUndoDelayMs(Number.POSITIVE_INFINITY)).toBe(
			DEFAULT_HUMAN_APPROVE_UNDO_DELAY_MS
		);
	});
});

// ============================================================
// updateConfig — the window is operator-configurable
// ============================================================

describe('agentConfig.humanApproveUndoDelayMs via updateConfig', () => {
	it('persists a clamped window', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t);

		await t.mutation(api.agentConfigMutations.updateConfig, {
			humanApproveUndoDelayMs: 500_000,
		});

		await t.run(async (ctx) => {
			const configs = await ctx.db.query('agentConfig').take(1);
			expect(configs[0]?.humanApproveUndoDelayMs).toBe(MAX_HUMAN_APPROVE_UNDO_DELAY_MS);
		});
	});

	it('accepts 0 (immediate sends) on create', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(api.agentConfigMutations.updateConfig, {
			humanApproveUndoDelayMs: 0,
		});

		await t.run(async (ctx) => {
			const configs = await ctx.db.query('agentConfig').take(1);
			expect(configs[0]?.humanApproveUndoDelayMs).toBe(0);
		});
	});
});
