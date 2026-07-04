/**
 * Clarification answer-memory persistence (inbox/clarificationMemory.ts).
 *
 * End-to-end over a real (convex-test) datastore:
 *   - captureStandingAnswers stores an answered slot; a later matching thread
 *     fills it SILENTLY (resolveFills returns the value; no question is re-asked).
 *   - contact-scope isolation: an answer captured for contact A never fills a
 *     slot for contact B; a promoted org-general answer fills for anyone.
 *   - revokeClarificationMemory forgets it — the next matching thread asks again.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api, internal } from '../../_generated/api';
import { captureStandingAnswers } from '../clarificationMemory';

const sessionMocks = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'admin' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		requireOrgPermission: vi.fn(async () => undefined),
		getMutationContext: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
			activeOrganizationId: 'org-1',
		})),
	};
});

const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules)
		.filter(
			([path]) =>
				!path.includes('sesActions') &&
				!path.includes('agent/walker') &&
				!path.includes('agent/steps/index') &&
				!path.includes('agent/steps/classify') &&
				!path.includes('agent/steps/draft') &&
				!path.includes('agent/steps/clarify') &&
				!path.includes('knowledgeExtraction') &&
				!path.includes('semanticFileProcessing') &&
				!path.includes('visualizationAgent') &&
				!path.includes('llmProvider')
		)
		.map(([key, val]) =>
			key.startsWith('../') && !key.startsWith('../../')
				? (['../../inbox/' + key.slice(3), val] as const)
				: ([key, val] as const)
		)
);

async function seedContact(
	t: ReturnType<typeof convexTest>,
	email: string
): Promise<Id<'contacts'>> {
	let contactId!: Id<'contacts'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		contactId = await ctx.db.insert('contacts', {
			email,
			source: 'inbound',
			doiStatus: 'not_required',
			createdAt: now,
			updatedAt: now,
		});
	});
	return contactId;
}

const DOCK_QUESTION = {
	id: 'q1',
	slotType: 'factual_lookup',
	text: 'Which dock should the delivery use?',
};

describe('captureStandingAnswers + resolveFills', () => {
	it('stores an answered slot and fills it silently on a later matching thread', async () => {
		const t = convexTest(schema, modules);
		const contactId = await seedContact(t, 'ops@acme.test');

		// The owner answers the clarification once.
		await t.run(async (ctx) => {
			await captureStandingAnswers(ctx, {
				contactId,
				source: 'agent',
				answers: [
					{
						slotType: DOCK_QUESTION.slotType,
						questionText: DOCK_QUESTION.text,
						value: 'Bay 3',
					},
				],
			});
		});

		// A later thread with the same contact + question: filled from memory.
		const { fills } = await t.mutation(internal.inbox.clarificationMemory.resolveFills, {
			contactId,
			questions: [DOCK_QUESTION],
		});
		expect(fills).toEqual([{ questionId: 'q1', slotType: 'factual_lookup', value: 'Bay 3' }]);

		// The fill bumped usage on the stored row.
		await t.run(async (ctx) => {
			const rows = await ctx.db.query('clarificationMemory').collect();
			expect(rows).toHaveLength(1);
			expect(rows[0]!.useCount).toBe(1);
			expect(rows[0]!.lastUsedAt).toBeGreaterThan(0);
		});
	});

	it('does not fill across contact scope (A answered, B asking)', async () => {
		const t = convexTest(schema, modules);
		const contactA = await seedContact(t, 'a@acme.test');
		const contactB = await seedContact(t, 'b@acme.test');

		await t.run(async (ctx) => {
			await captureStandingAnswers(ctx, {
				contactId: contactA,
				source: 'agent',
				answers: [
					{ slotType: DOCK_QUESTION.slotType, questionText: DOCK_QUESTION.text, value: 'Bay 3' },
				],
			});
		});

		const { fills } = await t.mutation(internal.inbox.clarificationMemory.resolveFills, {
			contactId: contactB,
			questions: [DOCK_QUESTION],
		});
		expect(fills).toEqual([]);
	});

	it('a promoted org-general answer fills for any contact', async () => {
		const t = convexTest(schema, modules);
		const contactA = await seedContact(t, 'a@acme.test');
		const contactB = await seedContact(t, 'b@acme.test');

		await t.run(async (ctx) => {
			await captureStandingAnswers(ctx, {
				contactId: contactA,
				source: 'agent',
				answers: [
					{ slotType: DOCK_QUESTION.slotType, questionText: DOCK_QUESTION.text, value: 'Bay 3' },
				],
			});
		});

		// Promote to org-general (the gated widening).
		let rowId!: Id<'clarificationMemory'>;
		await t.run(async (ctx) => {
			const rows = await ctx.db.query('clarificationMemory').collect();
			rowId = rows[0]!._id;
		});
		await t.mutation(api.inbox.clarificationMemory.promoteClarificationMemory, { id: rowId });

		const { fills } = await t.mutation(internal.inbox.clarificationMemory.resolveFills, {
			contactId: contactB,
			questions: [DOCK_QUESTION],
		});
		expect(fills).toEqual([{ questionId: 'q1', slotType: 'factual_lookup', value: 'Bay 3' }]);
	});

	it('a correction (same slot, new value) overwrites rather than duplicating', async () => {
		const t = convexTest(schema, modules);
		const contactId = await seedContact(t, 'ops@acme.test');

		await t.run(async (ctx) => {
			await captureStandingAnswers(ctx, {
				contactId,
				source: 'agent',
				answers: [
					{ slotType: DOCK_QUESTION.slotType, questionText: DOCK_QUESTION.text, value: 'Bay 3' },
				],
			});
			await captureStandingAnswers(ctx, {
				contactId,
				source: 'agent',
				answers: [
					{ slotType: DOCK_QUESTION.slotType, questionText: DOCK_QUESTION.text, value: 'Bay 7' },
				],
			});
		});

		await t.run(async (ctx) => {
			const rows = await ctx.db.query('clarificationMemory').collect();
			expect(rows).toHaveLength(1);
			expect(rows[0]!.answerValue).toBe('Bay 7');
			expect(rows[0]!.answerCount).toBe(2);
		});
	});

	it('does not store when no contact resolves (no accidental org-general fact)', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const res = await captureStandingAnswers(ctx, {
				source: 'agent',
				answers: [
					{ slotType: DOCK_QUESTION.slotType, questionText: DOCK_QUESTION.text, value: 'Bay 3' },
				],
			});
			expect(res.stored).toBe(0);
			const rows = await ctx.db.query('clarificationMemory').collect();
			expect(rows).toHaveLength(0);
		});
	});
});

describe('revokeClarificationMemory', () => {
	it('forgets the answer so the next matching thread asks again', async () => {
		const t = convexTest(schema, modules);
		const contactId = await seedContact(t, 'ops@acme.test');

		await t.run(async (ctx) => {
			await captureStandingAnswers(ctx, {
				contactId,
				source: 'agent',
				answers: [
					{ slotType: DOCK_QUESTION.slotType, questionText: DOCK_QUESTION.text, value: 'Bay 3' },
				],
			});
		});

		const { items } = await t.query(api.inbox.clarificationMemory.listClarificationMemory, {});
		expect(items).toHaveLength(1);
		expect(items[0]!.answerValue).toBe('Bay 3');

		await t.mutation(api.inbox.clarificationMemory.revokeClarificationMemory, {
			id: items[0]!.id,
		});

		const { fills } = await t.mutation(internal.inbox.clarificationMemory.resolveFills, {
			contactId,
			questions: [DOCK_QUESTION],
		});
		expect(fills).toEqual([]);

		await t.run(async (ctx) => {
			const rows = await ctx.db.query('clarificationMemory').collect();
			expect(rows).toHaveLength(0);
		});
	});
});
