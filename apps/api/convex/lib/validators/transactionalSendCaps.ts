import { v } from 'convex/values';

/**
 * The transactional send caps an instance admin set (`instanceSettings.
 * transactionalSendCaps`). Unset means the defaults in
 * `transactional/sendCapsPolicy.ts`. A cap that is off says so with
 * `isEnabled: false` and keeps its count, so switching it back on restores the
 * number the admin chose; a count is never 0.
 */
export const transactionalSendCapsValidator = v.object({
	perRecipient: v.object({
		isEnabled: v.boolean(),
		// Sends of one template to one address within `windowMs`.
		count: v.number(),
		windowMs: v.number(),
	}),
	perApiKeyDaily: v.object({
		isEnabled: v.boolean(),
		// Sends one API key may have accepted per UTC day.
		count: v.number(),
	}),
	updatedAt: v.number(),
	updatedBy: v.string(),
});
