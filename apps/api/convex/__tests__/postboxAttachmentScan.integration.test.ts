/**
 * H3 — Postbox attachment-scan gate.
 *
 * The full `dispatchDraft` action is `'use node'` and hits the MTA over
 * fetch, so end-to-end testing it under convex-test is awkward. We cover
 * the key behaviour by testing the lifecycle's
 * `transition({ to: 'draft', reason: 'scan_blocked' })` call that the
 * malware-blocked branch makes: a draft in pending_send state is dropped
 * back to 'draft' with no undoToken / scheduledSendAt, so the user can
 * edit it again rather than the row staying stuck.
 *
 * The scan-call itself is unit-testable in isolation — for now we rely on
 * the wiring in `mail/outbound.ts` and the explicit fail-closed branch.
 *
 * Post-ADR-0028: the inline `markDispatchFailed` mutation moved to the
 * Mail draft lifecycle (module). This test exercises the same revert
 * behaviour through the lifecycle's typed `transition` surface.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
			activeOrganizationId: 'test-org',
		}),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) =>
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

async function seedDraftInPendingSend(
	t: ReturnType<typeof convexTest>
): Promise<Id<'mailDrafts'>> {
	let id!: Id<'mailDrafts'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'test-user',
			organizationId: 'test-org',
			address: 'alice@example.com',
			domain: 'example.com',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		id = await ctx.db.insert('mailDrafts', {
			mailboxId,
			toAddresses: ['bob@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			fromAddress: 'alice@example.com',
			subject: 'hi',
			bodyHtml: '<p>hi</p>',
			attachments: [],
			state: 'pending_send',
			scheduledSendAt: now + 10_000,
			undoToken: 'tok-abc',
			lastEditedAt: now,
			createdAt: now,
		});
	});
	return id;
}

describe('mail.draftLifecycle.transition — scan_blocked revert', () => {
	it('reverts a pending_send draft to draft state', async () => {
		const t = convexTest(schema, modules);
		const draftId = await seedDraftInPendingSend(t);

		const outcome = await t.mutation(internal.mail.draftLifecycle.transition, {
			draftId,
			input: {
				to: 'draft',
				at: Date.now(),
				reason: 'scan_blocked',
			},
		});
		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const draft = await ctx.db.get(draftId);
			expect(draft?.state).toBe('draft');
			expect(draft?.undoToken).toBeUndefined();
			expect(draft?.scheduledSendAt).toBeUndefined();
		});
	});

	it('returns draft_not_found when the draft no longer exists', async () => {
		const t = convexTest(schema, modules);
		let draftId!: Id<'mailDrafts'>;
		await t.run(async (ctx) => {
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: 'test-user',
				organizationId: 'test-org',
				address: 'a@b.com',
				domain: 'b.com',
				status: 'active',
				usedBytes: 0,
				uidValidity: 1,
				createdAt: 1,
				updatedAt: 1,
			});
			draftId = await ctx.db.insert('mailDrafts', {
				mailboxId,
				toAddresses: [],
				ccAddresses: [],
				bccAddresses: [],
				fromAddress: 'a@b.com',
				subject: '',
				bodyHtml: '',
				attachments: [],
				state: 'draft',
				lastEditedAt: 1,
				createdAt: 1,
			});
			// Delete the draft so the mutation sees a missing row.
			await ctx.db.delete(draftId);
		});

		const outcome = await t.mutation(internal.mail.draftLifecycle.transition, {
			draftId,
			input: { to: 'draft', at: Date.now(), reason: 'scan_blocked' },
		});
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('draft_not_found');
	});
});
