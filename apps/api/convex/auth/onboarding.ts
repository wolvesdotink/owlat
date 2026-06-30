import { v } from 'convex/values';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { requireSelf } from '../lib/sessionOrganization';
import { isDeliveryConfigured } from '../lib/sendProviders/capability';

/**
 * Get the onboarding progress with computed step completion based on actual data.
 *
 * Progress is INSTANCE-WIDE (single org per deployment): every step flag is
 * derived live from real instance data — a configured delivery provider, a
 * contact, an email, a sent campaign, an API key, and a verified domain — so
 * there is nothing per-user to store. `sendPathReady` is the critical pre-send
 * signal: without a delivery provider an instance can verify a domain and still
 * not be able to send a single email, so it is its own step rather than implied
 * by domain verification.
 *
 * Dismissal is likewise instance-scoped: if ANY admin dismissed the onboarding
 * surface the whole instance treats it as dismissed, so the dashboard agrees
 * across admins and browsers (the dismissal is no longer a per-user /
 * localStorage flag that disagrees with the shared progress).
 */
export const getWithActualProgress = authedQuery({
	args: {
		userId: v.string(),
	},
	handler: async (ctx, args) => {
		await requireSelf(ctx, args.userId);

		// Check actual data to determine step completion
		const [sendPathReady, hasContacts, hasEmails, hasSentCampaign, hasApiKey, hasVerifiedDomain] =
			await Promise.all([
				// Can this instance actually deliver mail? (provider + creds, or a
				// providerRoutes row) — the real pre-send gate, not domain verification.
				isDeliveryConfigured(ctx),
				// Check for at least one contact
				ctx.db
					.query('contacts')
					.first()
					.then((c) => !!c),
				// Check for at least one email template
				ctx.db
					.query('emailTemplates')
					.first()
					.then((e) => !!e),
				// Check for at least one sent campaign — indexed lookup.
				ctx.db
					.query('campaigns')
					.withIndex('by_status', (q) => q.eq('status', 'sent'))
					.first()
					.then((c) => !!c),
				// Check for at least one API key — the transactional/API on-ramp, so
				// onboarding covers programmatic sending, not just marketing campaigns.
				ctx.db
					.query('apiKeys')
					.first()
					.then((k) => !!k),
				// Check for at least one verified domain — indexed lookup.
				ctx.db
					.query('domains')
					.withIndex('by_status', (q) => q.eq('status', 'verified'))
					.first()
					.then((d) => !!d),
			]);

		const flags = {
			sendPathReady,
			addedContacts: hasContacts,
			createdEmail: hasEmails,
			sentCampaign: hasSentCampaign,
			createdApiKey: hasApiKey,
			setupDomain: hasVerifiedDomain,
		};
		const completedSteps = Object.values(flags).filter(Boolean).length;
		const totalSteps = Object.keys(flags).length;
		const isComplete = completedSteps === totalSteps;

		// Instance-wide dismissal: dismissed if ANY admin dismissed the surface.
		const dismissalRecord = await ctx.db
			.query('onboardingProgress')
			.withIndex('by_dismissed', (q) => q.eq('dismissed', true))
			.first();

		return {
			...flags,
			dismissed: !!dismissalRecord,
			dismissedAt: dismissalRecord?.dismissedAt,
			completedSteps,
			totalSteps,
			isComplete,
		};
	},
});

/**
 * Dismiss the onboarding surface for the whole instance.
 *
 * Records which admin dismissed it (`userId`), but the read side
 * (`getWithActualProgress`) ORs across every record, so dismissing once — as any
 * admin, in any browser — hides the surface everywhere. This matches the
 * instance-wide progress: a single org per deployment has a single onboarding
 * state, not one per user.
 */
// authz: self — requireSelf asserts args.userId is the caller.
export const dismiss = authedMutation({
	args: {
		userId: v.string(),
	},
	handler: async (ctx, args) => {
		await requireSelf(ctx, args.userId);

		// Get or create this admin's dismissal record
		const progress = await ctx.db
			.query('onboardingProgress')
			.withIndex('by_user', (q) => q.eq('userId', args.userId))
			.first();

		const now = Date.now();

		if (!progress) {
			await ctx.db.insert('onboardingProgress', {
				userId: args.userId,
				dismissed: true,
				createdAt: now,
				updatedAt: now,
				dismissedAt: now,
			});
		} else {
			await ctx.db.patch(progress._id, {
				dismissed: true,
				dismissedAt: now,
				updatedAt: now,
			});
		}
	},
});
