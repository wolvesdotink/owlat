import { v } from 'convex/values';

/**
 * Saved-block rerender state on a template row (`emailTemplates`,
 * `transactionalEmails`). `stale: true` means `htmlContent` no longer matches
 * `content` because a linked saved block was edited; the rerender pool clears
 * it once the action succeeds and counts its failures here. Per ADR-0023.
 */
export const htmlRenderStateValidator = v.object({
	stale: v.boolean(),
	failureCount: v.optional(v.number()),
	lastFailureAt: v.optional(v.number()),
});
