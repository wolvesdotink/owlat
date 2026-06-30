import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { getOptional } from './lib/env';
import { formatFromAddress } from './lib/emailProviders/domainVerification';
import { generateConfirmationEmailHtml } from './lib/systemEmails';

/**
 * Send a double opt-in confirmation email
 */
export const sendConfirmationEmail = internalAction({
	args: {
		email: v.string(),
		firstName: v.optional(v.string()),
		confirmationToken: v.string(),
		siteUrl: v.string(),
	},
	handler: async (ctx, args): Promise<{ success: boolean }> => {
		// Get team info for the email
		const team = await ctx.runQuery(internal.confirmationEmailQueries.getTeamInfo, {});

		const teamName = team?.name || 'Newsletter';
		const fromEmail =
			team?.defaultFromEmail || `noreply@${getOptional('DEFAULT_FROM_DOMAIN') || 'mail.owlat.app'}`;
		const fromName = team?.defaultFromName || teamName;

		// Build confirmation URL
		const confirmationUrl = `${args.siteUrl}/confirm?token=${encodeURIComponent(args.confirmationToken)}`;

		// Generate email HTML
		const html = generateConfirmationEmailHtml(args.firstName, confirmationUrl, teamName);

		// Send through the configured system transport (Send system email module).
		// Routes to whatever delivery provider is configured (MTA / Resend / SES),
		// so this no longer requires the built-in MTA to be running.
		await ctx.runAction(internal.systemMail.sendSystemEmail, {
			to: args.email,
			from: formatFromAddress(fromEmail, fromName),
			subject: `Confirm your subscription to ${teamName}`,
			html,
		});

		return { success: true };
	},
});
