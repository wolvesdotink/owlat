/**
 * Read on arrival (SPEC §4.2): the async compile of a Fix reason into a rule
 * draft. `fix.apply` writes the `mailRuleDrafts` row and schedules
 * {@link compile}; the compile itself is the `compileFixRuleDraft` hook
 * (`./hooks.ts`), which lane rules / wiring connect to the §6.1 compile
 * action. The draft only ever becomes a disabled rule for review.
 */

import { v } from 'convex/values';
import { internalAction } from '../../_generated/server';
import { compileFixRuleDraft } from './hooks';

export const compile = internalAction({
	args: { draftId: v.id('mailRuleDrafts') },
	handler: async (ctx, args): Promise<void> => {
		await compileFixRuleDraft(ctx, args);
	},
});
