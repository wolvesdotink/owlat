/**
 * Non-destructive draft revisions (adoption-gaps piece D1', decision D7).
 *
 * Saving a draft WITHOUT approving appends to `draftRevisions[]` — the agent's
 * original is seeded as immutable revision 0 on the first save — stamps
 * `draftSavedAt`, leaves the row in `draft_ready`, and records NO autonomy
 * feedback. The `'edited'` signal moves to SEND-FIRE time (with the
 * `'approved'` row — `decisionFeedback.recordApprovalSignalsAtSend`, invoked
 * when the approved send actually leaves): exactly one row, iff the sent text
 * differs from the agent original. Covers:
 *   - revision append order (seed + one entry per save, latest text wins),
 *   - the agent original staying immutable across saves,
 *   - save recording no autonomy feedback (only the audit row),
 *   - editDraft (the AiReviseBox apply path) sharing the same semantics,
 *   - approve-after-edits recording exactly one 'edited' at send fire,
 *   - approve of an untouched (or reverted) draft recording none,
 *   - a human-composed reply to a draftless escalation seeding no fake
 *     agent original and never counting as 'edited'.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';

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

const AGENT_TEXT = 'Thanks for reaching out — the agent original.';

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
			draftResponse: AGENT_TEXT,
			draftSubject: 'Re: Help please',
			receivedAt: Date.now(),
			...overrides,
		});
	});
}

async function getMessage(
	t: ReturnType<typeof convexTest>,
	id: Id<'inboundMessages'>
): Promise<Doc<'inboundMessages'>> {
	return await t.run(async (ctx) => (await ctx.db.get(id))!);
}

async function feedbackActions(t: ReturnType<typeof convexTest>): Promise<string[]> {
	return await t.run(async (ctx) =>
		(await ctx.db.query('autonomyFeedback').collect()).map((f) => f.action)
	);
}

// ============================================================
// saveDraftRevision — append order + immutability + stamps
// ============================================================

describe('saveDraftRevision — revision history', () => {
	it('seeds the agent original as revision 0 and appends saves in order', async () => {
		const t = convexTest(schema, modules);
		const id = await createDraftReadyMessage(t);

		await t.mutation(api.inbox.draftRevisions.saveDraftRevision, {
			inboundMessageId: id,
			draftResponse: 'First human pass.',
		});
		await t.mutation(api.inbox.draftRevisions.saveDraftRevision, {
			inboundMessageId: id,
			draftResponse: 'Second human pass.',
			draftSubject: 'Re: Help please (updated)',
		});

		const msg = await getMessage(t, id);
		expect(msg.draftRevisions?.map((r) => r.text)).toEqual([
			AGENT_TEXT,
			'First human pass.',
			'Second human pass.',
		]);
		expect(msg.draftRevisions?.map((r) => r.savedBy)).toEqual([
			'agent',
			'reviewer-1',
			'reviewer-1',
		]);
		// The latest save is the working draft; the row never left the queue.
		expect(msg.draftResponse).toBe('Second human pass.');
		expect(msg.draftSubject).toBe('Re: Help please (updated)');
		expect(msg.processingStatus).toBe('draft_ready');
		expect(msg.draftSavedAt).toBeDefined();
	});

	it('keeps the agent original immutable across saves', async () => {
		const t = convexTest(schema, modules);
		const id = await createDraftReadyMessage(t);

		for (const text of ['v1', 'v2', 'v3']) {
			await t.mutation(api.inbox.draftRevisions.saveDraftRevision, {
				inboundMessageId: id,
				draftResponse: text,
			});
		}

		const msg = await getMessage(t, id);
		expect(msg.draftRevisions?.[0]).toMatchObject({
			text: AGENT_TEXT,
			subject: 'Re: Help please',
			savedBy: 'agent',
		});
		expect(msg.draftRevisions).toHaveLength(4);
	});

	it('skips a duplicate consecutive revision but still stamps draftSavedAt', async () => {
		const t = convexTest(schema, modules);
		const id = await createDraftReadyMessage(t);

		await t.mutation(api.inbox.draftRevisions.saveDraftRevision, {
			inboundMessageId: id,
			draftResponse: 'Edited once.',
		});
		const stampBefore = (await getMessage(t, id)).draftSavedAt;
		await t.mutation(api.inbox.draftRevisions.saveDraftRevision, {
			inboundMessageId: id,
			draftResponse: '  Edited once.  ', // whitespace churn is not a new revision
		});

		const msg = await getMessage(t, id);
		expect(msg.draftRevisions).toHaveLength(2); // agent original + one edit
		expect(msg.draftSavedAt).toBeGreaterThanOrEqual(stampBefore!);
	});

	it('records NO autonomy feedback on save — only the audit row', async () => {
		const t = convexTest(schema, modules);
		const id = await createDraftReadyMessage(t);

		await t.mutation(api.inbox.draftRevisions.saveDraftRevision, {
			inboundMessageId: id,
			draftResponse: 'A better reply.',
		});

		expect(await feedbackActions(t)).toEqual([]);
		await t.run(async (ctx) => {
			const audits = (await ctx.db.query('auditLogs').collect()).filter(
				(l) => l.action === 'inbound.draft_saved'
			);
			expect(audits).toHaveLength(1);
			expect(audits[0]).toMatchObject({ resourceId: id, userId: 'reviewer-1' });
		});
	});

	it('editDraft (the AiReviseBox apply path) is revision-appending and feedback-free too', async () => {
		const t = convexTest(schema, modules);
		const id = await createDraftReadyMessage(t);

		await t.mutation(api.inbox.mutations.editDraft, {
			inboundMessageId: id,
			draftResponse: 'Revised by instruction.',
		});

		const msg = await getMessage(t, id);
		expect(msg.draftRevisions?.map((r) => r.text)).toEqual([AGENT_TEXT, 'Revised by instruction.']);
		expect(msg.draftResponse).toBe('Revised by instruction.');
		expect(msg.draftSavedAt).toBeDefined();
		expect(await feedbackActions(t)).toEqual([]); // no 'edited' at save time
	});
});

// ============================================================
// The 'edited' signal fires at send time, once, iff text differs
// ============================================================

/** Approve, then fire the send-time recorder — the moment the held send
 * actually leaves (`sendApprovedReply` invokes exactly this mutation). */
async function approveAndFireSend(t: ReturnType<typeof convexTest>, id: Id<'inboundMessages'>) {
	const result = await t.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: id });
	expect(result.success).toBe(true);
	await t.mutation(internal.inbox.decisionFeedback.recordApprovalSignalsAtSend, {
		inboundMessageId: id,
	});
}

describe("send-time 'edited' signal", () => {
	it('approve after edits records exactly one edited (plus the approved) at send fire', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 15_000 });
		const id = await createDraftReadyMessage(t);

		// Two saves — still only ONE 'edited' fires, when the send does.
		await t.mutation(api.inbox.draftRevisions.saveDraftRevision, {
			inboundMessageId: id,
			draftResponse: 'First pass.',
		});
		await t.mutation(api.inbox.draftRevisions.saveDraftRevision, {
			inboundMessageId: id,
			draftResponse: 'Final human wording.',
		});
		await approveAndFireSend(t, id);

		const actions = await feedbackActions(t);
		expect(actions.filter((a) => a === 'edited')).toHaveLength(1);
		expect(actions.filter((a) => a === 'approved')).toHaveLength(1);
	});

	it('approve alone records nothing until the send fires (G3)', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 15_000 });
		const id = await createDraftReadyMessage(t);

		await t.mutation(api.inbox.draftRevisions.saveDraftRevision, {
			inboundMessageId: id,
			draftResponse: 'Edited wording.',
		});
		await t.mutation(api.inbox.mutations.approveDraft, { inboundMessageId: id });

		// The held send has not left yet — no signals, so an undo retracts nothing.
		expect(await feedbackActions(t)).toEqual([]);
	});

	it('approve of an untouched draft records no edited', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 15_000 });
		const id = await createDraftReadyMessage(t);

		await approveAndFireSend(t, id);

		const actions = await feedbackActions(t);
		expect(actions).toEqual(['approved']);
	});

	it('a save reverted back to the agent original honestly counts as unedited', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 15_000 });
		const id = await createDraftReadyMessage(t);

		await t.mutation(api.inbox.draftRevisions.saveDraftRevision, {
			inboundMessageId: id,
			draftResponse: 'A detour.',
		});
		await t.mutation(api.inbox.draftRevisions.saveDraftRevision, {
			inboundMessageId: id,
			draftResponse: AGENT_TEXT,
		});
		await approveAndFireSend(t, id);

		const actions = await feedbackActions(t);
		expect(actions.filter((a) => a === 'edited')).toHaveLength(0);
	});

	it('a human-composed reply to a draftless escalation seeds no agent original and never counts as edited', async () => {
		const t = convexTest(schema, modules);
		await setAgentConfig(t, { humanApproveUndoDelayMs: 15_000 });
		const id = await createDraftReadyMessage(t, {
			draftResponse: undefined,
			draftSubject: undefined,
		});

		// The queue's compose→send path: editDraft writes the reply, approve sends.
		await t.mutation(api.inbox.mutations.editDraft, {
			inboundMessageId: id,
			draftResponse: 'Human-composed escalation reply.',
		});
		const msg = await getMessage(t, id);
		expect(msg.draftRevisions?.map((r) => r.savedBy)).toEqual(['reviewer-1']);

		await approveAndFireSend(t, id);
		const actions = await feedbackActions(t);
		expect(actions.filter((a) => a === 'edited')).toHaveLength(0);
	});
});
