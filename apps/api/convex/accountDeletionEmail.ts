import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { getOptional } from './lib/env';
import { generateDeletionEmailHtml } from './lib/systemEmails';
import { deletionEmailCopy, systemEmailBcp47, systemEmailLocale } from './lib/systemEmailCopy';
import { appLocaleValidator } from './lib/convexValidators';

/**
 * Send account deletion confirmation email
 */
export const sendAccountDeletionEmail = internalAction({
	args: {
		email: v.string(),
		scheduledForDeletion: v.number(),
		cancellationToken: v.string(),
		siteUrl: v.string(),
		/**
		 * The recipient's chosen interface language (`userProfiles.locale`).
		 * Absent — an account that never touched the language picker, or a caller
		 * that predates this argument — means English, which is what this mail
		 * always was.
		 */
		locale: v.optional(appLocaleValidator),
	},
	handler: async (ctx, args) => {
		const locale = systemEmailLocale(args.locale);
		const copy = deletionEmailCopy(locale);
		// The date said the reader's way: "Sunday, June 15, 2025" against
		// "Sonntag, 15. Juni 2025". This was hard-coded `'en-US'`, so a German
		// account was told the deletion date in a format it has to decode.
		const scheduledDate = new Date(args.scheduledForDeletion).toLocaleDateString(
			systemEmailBcp47(locale),
			{ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }
		);

		// Build cancellation URL
		const cancelUrl = `${args.siteUrl}/cancel-deletion?token=${encodeURIComponent(args.cancellationToken)}`;

		// Generate email HTML
		const html = generateDeletionEmailHtml(args.email, scheduledDate, cancelUrl, locale);

		// Send through the configured system transport (Send system email module).
		// Routes to whatever delivery provider is configured (MTA / Resend / SES).
		await ctx.runAction(internal.systemMail.sendSystemEmail, {
			to: args.email,
			from: `Owlat <noreply@${getOptional('DEFAULT_FROM_DOMAIN') || 'mail.owlat.app'}>`,
			subject: copy.subject,
			html,
		});

		return { success: true };
	},
});
