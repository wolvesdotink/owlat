/**
 * Bulk review-queue decisions (adoption-gaps piece C2, decision D6).
 *
 * `approveDrafts` returns one outcome per id (`approved | no_draft |
 * reply_in_progress | not_found`) and never throws on a partially-failing
 * batch; every approved item shares ONE C1 undo window and its own audit row
 * (approve feedback records at send-fire time, G3); the companion
 * `undoAutoSends` cancels per id; and
 * `rejectDrafts` rides along in the same batch shape. Covers:
 *   - a mixed batch (ok / no draft / collision / missing id) without throwing,
 *   - one shared undo window across the batch's approved items,
 *   - per-id undo through undoAutoSends (partial: one already fired),
 *   - audit rows per item at approve time; feedback only once sends fire,
 *   - an undone bulk approve trains the learning loop not at all,
 *   - bulk reject's batch shape (rejected / not_found),
 *   - the 50-item cap and id dedupe.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';

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

/** An id whose row has been deleted — a well-formed but missing reference. */
async function createMissingId(t: ReturnType<typeof convexTest>): Promise<Id<'inboundMessages'>> {
	const id = await createDraftReadyMessage(t);
	await t.run(async (ctx) => {
		await ctx.db.delete(id);
	});
	return id;
}

/** Mark `teammate-1` (display name Dana) as actively replying on a thread. */
async function addActiveReplier(
	t: ReturnType<typeof convexTest>,
	threadId: Id<'conversationThreads'>
) {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('userProfiles', {
			authUserId: 'teammate-1',
			email: 'dana@owlat.app',
			name: 'Dana',
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert('threadPresence', {
			threadId,
			userId: 'teammate-1',
			mode: 'replying',
			heartbeatAt: now,
		});
	});
}

function outcomeFor<T extends { inboundMessageId: string }>(
	result: { outcomes: T[] },
	id: string
): T | undefined {
	return result.outcomes.find((o) => o.inboundMessageId === id);
}

// ============================================================
// approveDrafts — mixed outcomes, never throwing
// ============================================================

describe('approveDrafts — per-id outcomes', () => {
	it('handles a mixed batch (ok / no draft / collision / missing id) without throwing', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 20_000 });

		const okId = await createDraftReadyMessage(t);
		const draftlessId = await createDraftReadyMessage(t, { draftResponse: undefined });
		const collisionThread = await createThread(t);
		const heldId = await createDraftReadyMessage(t, { threadId: collisionThread });
		await addActiveReplier(t, collisionThread);
		const missingId = await createMissingId(t);

		const before = Date.now();
		const result = await t.mutation(api.inbox.bulkMutations.approveDrafts, {
			inboundMessageIds: [okId, draftlessId, heldId, missingId],
		});

		expect(result.outcomes).toHaveLength(4);
		expect(outcomeFor(result, okId)).toEqual({ inboundMessageId: okId, outcome: 'approved' });
		expect(outcomeFor(result, draftlessId)).toEqual({
			inboundMessageId: draftlessId,
			outcome: 'no_draft',
		});
		expect(outcomeFor(result, heldId)).toEqual({
			inboundMessageId: heldId,
			outcome: 'reply_in_progress',
			heldByName: 'Dana',
		});
		expect(outcomeFor(result, missingId)).toEqual({
			inboundMessageId: missingId,
			outcome: 'not_found',
		});

		// The batch's shared undo window is returned once, C1-style.
		expect(result.undo?.sendAt).toBeGreaterThanOrEqual(before + 20_000 - 1_000);

		// Only the approved item transitioned; the held/draftless rows stay queued.
		await t.run(async (ctx) => {
			expect((await ctx.db.get(okId))?.processingStatus).toBe('approved');
			expect((await ctx.db.get(okId))?.pendingAutoSend?.scheduledFnId).toBeDefined();
			expect((await ctx.db.get(draftlessId))?.processingStatus).toBe('draft_ready');
			expect((await ctx.db.get(heldId))?.processingStatus).toBe('draft_ready');
		});
	});

	it('maps a row that already left the queue to not_found', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 15_000 });
		const sentId = await createDraftReadyMessage(t, { processingStatus: 'sent' });

		const result = await t.mutation(api.inbox.bulkMutations.approveDrafts, {
			inboundMessageIds: [sentId],
		});

		expect(outcomeFor(result, sentId)?.outcome).toBe('not_found');
		expect(result.undo).toBeUndefined(); // nothing approved — nothing to undo
	});

	it('shares ONE undo window across the batch and omits it at delay 0', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 30_000 });
		const a = await createDraftReadyMessage(t);
		const b = await createDraftReadyMessage(t);

		const result = await t.mutation(api.inbox.bulkMutations.approveDrafts, {
			inboundMessageIds: [a, b],
		});

		// Both markers carry the batch's single window (the effect runner stamps
		// each marker with its own Date.now(), so allow a few ms of skew — the
		// WINDOW is shared, resolved once for the whole batch).
		const sendAt = result.undo!.sendAt;
		await t.run(async (ctx) => {
			expect((await ctx.db.get(a))?.pendingAutoSend?.sendAt).toBeGreaterThanOrEqual(sendAt);
			expect((await ctx.db.get(a))?.pendingAutoSend?.sendAt).toBeLessThan(sendAt + 1_000);
			expect((await ctx.db.get(b))?.pendingAutoSend?.sendAt).toBeGreaterThanOrEqual(sendAt);
			expect((await ctx.db.get(b))?.pendingAutoSend?.sendAt).toBeLessThan(sendAt + 1_000);
		});

		// Window 0 restores the immediate send: no undo offered, no markers.
		const t2 = convexTest(schema, modules);
		await setAgentConfig(t2, { humanApproveUndoDelayMs: 0 });
		const c = await createDraftReadyMessage(t2);
		const immediate = await t2.mutation(api.inbox.bulkMutations.approveDrafts, {
			inboundMessageIds: [c],
		});
		expect(outcomeFor(immediate, c)?.outcome).toBe('approved');
		expect(immediate.undo).toBeUndefined();
		await t2.run(async (ctx) => {
			expect((await ctx.db.get(c))?.pendingAutoSend).toBeUndefined();
		});
	});

	it('records an audit row PER approved item; approve feedback defers to send-fire', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 15_000 });
		const a = await createDraftReadyMessage(t);
		const b = await createDraftReadyMessage(t);
		const draftless = await createDraftReadyMessage(t, { draftResponse: undefined });

		await t.mutation(api.inbox.bulkMutations.approveDrafts, {
			inboundMessageIds: [a, b, draftless],
		});

		await t.run(async (ctx) => {
			const audits = (await ctx.db.query('auditLogs').collect()).filter(
				(l) => l.action === 'inbound.draft_approved'
			);
			expect(audits.map((l) => l.resourceId).sort()).toEqual([a, b].sort());
			expect(audits.every((l) => l.userId === 'reviewer-1')).toBe(true);

			// G3: the trust signal fires only on real sends — the held approves
			// have not fired yet, so no feedback rows exist at approve time.
			const feedback = await ctx.db.query('autonomyFeedback').collect();
			expect(feedback).toHaveLength(0);
		});

		// When the shared window elapses each item's send fires and records its
		// own signal, exactly once per approved item.
		for (const id of [a, b]) {
			await t.mutation(internal.inbox.decisionFeedback.recordApprovalSignalsAtSend, {
				inboundMessageId: id,
			});
		}
		await t.run(async (ctx) => {
			const feedback = await ctx.db.query('autonomyFeedback').collect();
			expect(feedback.filter((f) => f.action === 'approved')).toHaveLength(2);
		});
	});

	it('a bulk approve undone inside its shared window trains nothing', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 30_000 });
		const a = await createDraftReadyMessage(t);
		const b = await createDraftReadyMessage(t);

		await t.mutation(api.inbox.bulkMutations.approveDrafts, { inboundMessageIds: [a, b] });
		const undone = await t.mutation(api.inbox.bulkMutations.undoAutoSends, {
			inboundMessageIds: [a, b],
		});
		expect(undone.outcomes.every((o) => o.cancelled)).toBe(true);

		await t.run(async (ctx) => {
			// The cancelled sends never fired — zero feedback rows to retract.
			expect(await ctx.db.query('autonomyFeedback').collect()).toHaveLength(0);
		});
	});

	it('dedupes repeated ids (one transition, one audit row, one outcome)', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 15_000 });
		const a = await createDraftReadyMessage(t);

		const result = await t.mutation(api.inbox.bulkMutations.approveDrafts, {
			inboundMessageIds: [a, a, a],
		});

		expect(result.outcomes).toHaveLength(1);
		await t.run(async (ctx) => {
			const audits = (await ctx.db.query('auditLogs').collect()).filter(
				(l) => l.action === 'inbound.draft_approved'
			);
			expect(audits).toHaveLength(1);
		});
	});

	it('refuses a batch over 50 ids up front — no partial application', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t);
		const ids: Id<'inboundMessages'>[] = [];
		for (let i = 0; i < 51; i++) ids.push(await createDraftReadyMessage(t));

		await expect(
			t.mutation(api.inbox.bulkMutations.approveDrafts, { inboundMessageIds: ids })
		).rejects.toThrow(/capped at 50/);

		await t.run(async (ctx) => {
			const first = await ctx.db.get(ids[0]!);
			expect(first?.processingStatus).toBe('draft_ready'); // nothing was approved
		});
	});
});

// ============================================================
// undoAutoSends — per-id undo of the shared window
// ============================================================

describe('undoAutoSends — per-id undo', () => {
	it('cancels every held send in the batch and restores draft_ready per id', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 30_000 });
		const a = await createDraftReadyMessage(t);
		const b = await createDraftReadyMessage(t);

		await t.mutation(api.inbox.bulkMutations.approveDrafts, { inboundMessageIds: [a, b] });

		const result = await t.mutation(api.inbox.bulkMutations.undoAutoSends, {
			inboundMessageIds: [a, b],
		});

		expect(result.outcomes).toHaveLength(2);
		expect(result.outcomes.every((o) => o.cancelled)).toBe(true);
		await t.run(async (ctx) => {
			expect((await ctx.db.get(a))?.processingStatus).toBe('draft_ready');
			expect((await ctx.db.get(b))?.processingStatus).toBe('draft_ready');
			expect((await ctx.db.get(a))?.pendingAutoSend).toBeUndefined();
		});
	});

	it('reports a partial undo honestly: a fired send stays sent, the rest come back', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 30_000 });
		const fired = await createDraftReadyMessage(t);
		const held = await createDraftReadyMessage(t);

		await t.mutation(api.inbox.bulkMutations.approveDrafts, {
			inboundMessageIds: [fired, held],
		});

		// Simulate `fired`'s window elapsing: its scheduled send left `pending`
		// while the marker is still on the row.
		await t.run(async (ctx) => {
			const m = await ctx.db.get(fired);
			await ctx.scheduler.cancel(m!.pendingAutoSend!.scheduledFnId);
		});

		const result = await t.mutation(api.inbox.bulkMutations.undoAutoSends, {
			inboundMessageIds: [fired, held],
		});

		expect(outcomeFor(result, fired)).toMatchObject({ cancelled: false, reason: 'already_sent' });
		expect(outcomeFor(result, held)).toMatchObject({ cancelled: true });
		await t.run(async (ctx) => {
			expect((await ctx.db.get(fired))?.processingStatus).toBe('approved');
			expect((await ctx.db.get(held))?.processingStatus).toBe('draft_ready');
		});
	});

	it('a missing id is a clean no_pending_send, not a throw', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t);
		const missing = await createMissingId(t);

		const result = await t.mutation(api.inbox.bulkMutations.undoAutoSends, {
			inboundMessageIds: [missing],
		});

		expect(outcomeFor(result, missing)).toMatchObject({
			cancelled: false,
			reason: 'no_pending_send',
		});
	});
});

// ============================================================
// rejectDrafts — the same batch shape
// ============================================================

describe('rejectDrafts — batch shape', () => {
	it('rejects a batch with per-id outcomes, feedback and audit rows per item', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t);
		const a = await createDraftReadyMessage(t);
		const b = await createDraftReadyMessage(t);
		const missing = await createMissingId(t);

		const result = await t.mutation(api.inbox.bulkMutations.rejectDrafts, {
			inboundMessageIds: [a, b, missing],
			reason: 'off-topic',
		});

		expect(outcomeFor(result, a)?.outcome).toBe('rejected');
		expect(outcomeFor(result, b)?.outcome).toBe('rejected');
		expect(outcomeFor(result, missing)?.outcome).toBe('not_found');

		await t.run(async (ctx) => {
			expect((await ctx.db.get(a))?.processingStatus).toBe('rejected');
			expect((await ctx.db.get(b))?.processingStatus).toBe('rejected');

			const audits = (await ctx.db.query('auditLogs').collect()).filter(
				(l) => l.action === 'inbound.draft_rejected'
			);
			expect(audits.map((l) => l.resourceId).sort()).toEqual([a, b].sort());
			expect(
				audits.every((l) => (l.details as { reason?: string } | undefined)?.reason === 'off-topic')
			).toBe(true);

			const feedback = await ctx.db.query('autonomyFeedback').collect();
			expect(feedback.filter((f) => f.action === 'rejected')).toHaveLength(2);
		});
	});

	it('maps a row that already left the queue to not_found without touching it', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t);
		const sentId = await createDraftReadyMessage(t, { processingStatus: 'sent' });

		const result = await t.mutation(api.inbox.bulkMutations.rejectDrafts, {
			inboundMessageIds: [sentId],
		});

		expect(outcomeFor(result, sentId)?.outcome).toBe('not_found');
		await t.run(async (ctx) => {
			expect((await ctx.db.get(sentId))?.processingStatus).toBe('sent');
			const feedback = await ctx.db.query('autonomyFeedback').collect();
			expect(feedback).toHaveLength(0); // no feedback for an untouched row
		});
	});
});
