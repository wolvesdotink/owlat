/**
 * One saved version of a Team inbox reply draft (`inboundMessages.draftRevisions`,
 * written by `inbox/draftRevisions.ts`). Revision 0 is the agent's original
 * (`savedBy: 'agent'`); every later one is a person's save (`savedBy` = their id).
 */
import { v } from 'convex/values';

export const draftRevisionValidator = v.object({
	text: v.string(),
	subject: v.optional(v.string()),
	savedAt: v.number(),
	savedBy: v.string(),
});
