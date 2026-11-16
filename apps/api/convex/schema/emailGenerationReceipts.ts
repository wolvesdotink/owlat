import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { generationResultValidator } from '../lib/validators/emailGeneration';

export const emailGenerationReceiptTables = {
	// One row per AI draft run that committed (`emailGeneration/receipts.ts`),
	// keyed by the request id the web client minted for that submission. It is
	// written in the transaction that creates the draft, so a repeat of the
	// submission whose answer was lost is answered from it instead of drafting
	// twice. Scoped to the organization and the member: another member's
	// guess of the id finds nothing.
	//
	// Only what the answer needs is kept: the ids of what was created and the
	// variables the mapper left out. No prompt, no content. Rows only need to
	// outlive a retry, so the hourly purge removes them after a day.
	emailGenerationReceipts: defineTable({
		organizationId: v.string(),
		userId: v.string(),
		requestId: v.string(),
		result: generationResultValidator,
		droppedVariables: v.array(v.string()),
		createdAt: v.number(),
	})
		.index('by_org_user_request', ['organizationId', 'userId', 'requestId'])
		.index('by_created_at', ['createdAt']),
};
