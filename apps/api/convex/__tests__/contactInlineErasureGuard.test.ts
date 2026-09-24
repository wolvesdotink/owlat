import { describe, it, expect, vi } from 'vitest';
import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { permanentlyDeleteContactWithRelations } from '../lib/contactMutations';

/**
 * The inline erasure must never remove the contact row while a phase is
 * unfinished: the rows that phase had not reached would dangle for good, and
 * the phases after it would never run. It used to ignore the walk's
 * `isComplete` and delete the contact regardless.
 */

const phases = vi.hoisted(() => ({
	advanceErasure: vi.fn(),
	finishErasure: vi.fn(),
}));

vi.mock('../contacts/erasure/phases', () => ({
	FIRST_ERASURE_PHASE: 'clarificationMemory',
	advanceErasure: phases.advanceErasure,
	finishErasure: phases.finishErasure,
}));

const ctx = {} as MutationCtx;
const contactId = 'contact-1' as Id<'contacts'>;

describe('permanentlyDeleteContactWithRelations — completeness guard', () => {
	it('throws and keeps the contact when the phases do not finish', async () => {
		phases.advanceErasure.mockReset().mockResolvedValue({
			phase: 'automationRuns',
			isComplete: false,
		});
		phases.finishErasure.mockReset();

		await expect(permanentlyDeleteContactWithRelations(ctx, contactId)).rejects.toThrow(
			/automationRuns/
		);
		expect(phases.finishErasure).not.toHaveBeenCalled();
	});

	it('resumes from where a pass stopped and finishes once the phases complete', async () => {
		phases.advanceErasure
			.mockReset()
			.mockResolvedValueOnce({ phase: 'automationRuns', isComplete: false })
			.mockResolvedValueOnce({ phase: 'semanticFiles', isComplete: true });
		phases.finishErasure.mockReset();

		await permanentlyDeleteContactWithRelations(ctx, contactId);

		expect(phases.advanceErasure.mock.calls[1]?.[2]).toMatchObject({ phase: 'automationRuns' });
		expect(phases.finishErasure).toHaveBeenCalledWith(ctx, contactId, { decrementCount: true });
	});
});
