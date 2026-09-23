import { describe, it, expect } from 'vitest';
import { internal } from '../_generated/api';
import { createTestContact } from './factories';
import { newHarness } from './testModules';
import { danglingContactReferences } from './helpers/contactErasure';
import { permanentlyDeleteContactWithRelations } from '../lib/contactMutations';
import { captureStandingAnswers } from '../inbox/clarificationMemory';

/**
 * Permanent contact deletion must take the contact's learned clarification
 * answers with it. They hold the question and the owner's answer about the
 * person, and the fill path would otherwise keep replaying them. A promoted
 * org-wide answer is a separate, retained policy: promotion already severed
 * it from the contact.
 */
describe('contact erasure — learned clarification answers', () => {
	it('deletes the contact-scoped answers, keeps promoted and other contacts’ answers', async () => {
		const t = newHarness();
		const erasedEmail = 'erased-person@example.com';

		const ids = await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact({ email: erasedEmail }));
			await ctx.db.insert('contactIdentities', {
				contactId,
				channel: 'email',
				identifier: erasedEmail,
				isPrimary: true,
				createdAt: Date.now(),
			});
			const otherId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'someone-else@example.com' })
			);

			await captureStandingAnswers(ctx, {
				contactId,
				source: 'agent',
				answers: [
					{ slotType: 'date', questionText: 'When is the handover?', value: 'Friday at noon' },
					{ slotType: 'amount', questionText: 'What budget did we agree?', value: 'EUR 4,200' },
					{ slotType: 'policy', questionText: 'Do we ship to Norway?', value: 'Yes, via DHL' },
				],
			});
			await captureStandingAnswers(ctx, {
				contactId: otherId,
				source: 'reply_queue',
				answers: [{ slotType: 'date', questionText: 'When is the handover?', value: 'Monday' }],
			});

			// The shipping answer was promoted org-wide by an admin before the
			// erasure — exactly what promoteClarificationMemory does.
			const rows = await ctx.db.query('clarificationMemory').collect();
			const promoted = rows.find((r) => r.slotType === 'policy')!;
			await ctx.db.patch(promoted._id, { contactId: undefined });

			return { contactId, otherId, promotedId: promoted._id };
		});

		await t.run(async (ctx) => {
			await permanentlyDeleteContactWithRelations(ctx, ids.contactId);
		});

		await t.run(async (ctx) => {
			const remaining = await ctx.db.query('clarificationMemory').collect();
			expect(remaining.map((r) => r.answerValue).sort()).toEqual(['Monday', 'Yes, via DHL']);
			expect(remaining.find((r) => r.answerValue === 'Yes, via DHL')?._id).toBe(ids.promotedId);
			expect(remaining.some((r) => r.contactId === ids.contactId)).toBe(false);
			expect(await danglingContactReferences(ctx, ids.contactId)).toEqual([]);
		});

		// Neither fill path can replay the erased answers any more: not through
		// the old contact id, not through the old sender address.
		for (const scope of [{ contactId: ids.contactId }, { fromAddress: erasedEmail }]) {
			const { fills } = await t.mutation(internal.inbox.clarificationMemory.resolveFills, {
				...scope,
				questions: [
					{ id: 'q1', slotType: 'date', text: 'When is the handover?' },
					{ id: 'q2', slotType: 'amount', text: 'What budget did we agree?' },
					{ id: 'q3', slotType: 'policy', text: 'Do we ship to Norway?' },
				],
			});
			expect(fills.map((f) => f.value)).toEqual(['Yes, via DHL']);
		}
	});
});
