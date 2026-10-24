/**
 * The review-only mark of a cheap-first draft: written with the draft it
 * describes, in the same mutation, and cleared by the next draft, so the
 * `cheap_first_draft` auto-send gate reads the mark of exactly the draft it
 * would send.
 */

import { describe, expect, it } from 'vitest';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { newHarness } from '../../__tests__/testModules';
import { createTestContact, createTestInboundMessage } from '../../__tests__/factories';

async function seed(t: ReturnType<typeof newHarness>): Promise<Id<'inboundMessages'>> {
	return t.run(async (ctx) => {
		const contactId = await ctx.db.insert(
			'contacts',
			createTestContact({ email: 'sam@acme.test' })
		);
		const { threadId: _thread, ...message } = createTestInboundMessage({
			contactId,
			processingStatus: 'drafting',
		});
		return ctx.db.insert('inboundMessages', message);
	});
}

const draft = (inboundMessageId: Id<'inboundMessages'>, text: string) => ({
	inboundMessageId,
	draftResponse: text,
	draftSubject: 'Re: Invoice',
	confidenceScore: 0.9,
});

describe('isCheapFirstDraft', () => {
	it('is set with a cheap-first draft and cleared by the next draft', async () => {
		const t = newHarness();
		const id = await seed(t);
		const read = () => t.run((ctx) => ctx.db.get(id));

		await t.mutation(internal.inbox.stepOutputs.recordDraftOutput, {
			...draft(id, 'Thanks, noted.'),
			isCheapFirstDraft: true,
		});
		expect(await read()).toMatchObject({
			draftResponse: 'Thanks, noted.',
			isCheapFirstDraft: true,
		});

		await t.mutation(internal.inbox.stepOutputs.recordDraftOutput, draft(id, 'Thanks Sam.'));
		const after = await read();
		expect(after?.draftResponse).toBe('Thanks Sam.');
		expect(after?.isCheapFirstDraft).toBeUndefined();
	});
});
