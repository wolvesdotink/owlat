import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { getOptional } from './lib/env';
import { generateDeletionEmailHtml } from './lib/systemEmails';

/**
 * Send account deletion confirmation email
 */
export const sendAccountDeletionEmail = internalAction({
	args: {
		email: v.string(),
		scheduledForDeletion: v.number(),
		cancellationToken: v.string(),
		siteUrl: v.string(),
	},
	handler: async (ctx, args) => {
		const scheduledDate = new Date(args.scheduledForDeletion).toLocaleDateString('en-US', {
			weekday: 'long',
			year: 'numeric',
			month: 'long',
			day: 'numeric',
		});

		// Build cancellation URL
		const cancelUrl = `${args.siteUrl}/cancel-deletion?token=${encodeURIComponent(args.cancellationToken)}`;

		// Generate email HTML
		const html = generateDeletionEmailHtml(args.email, scheduledDate, cancelUrl);

		// Send through the configured system transport (Send system email module).
		// Routes to whatever delivery provider is configured (MTA / Resend / SES).
		await ctx.runAction(internal.systemMail.sendSystemEmail, {
			to: args.email,
			from: `Owlat <noreply@${getOptional('DEFAULT_FROM_DOMAIN') || 'mail.owlat.app'}>`,
			subject: 'Your Owlat Account Deletion Request',
			html,
		});

		return { success: true };
	},
});
