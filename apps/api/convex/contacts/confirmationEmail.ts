/**
 * The double opt-in mail a pending signup is sent to confirm its address.
 */
import { v, type ObjectType } from 'convex/values';
import { internalAction, type ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { requireSystemSenderAddress } from '../lib/systemSender';
import { formatFromAddress } from '../lib/emailProviders/domainVerification';
import { generateConfirmationEmailHtml } from '../lib/systemEmails';

/** `sendConfirmationEmail`'s arguments. */
export const sendConfirmationEmailArgs = {
	email: v.string(),
	firstName: v.optional(v.string()),
	confirmationToken: v.string(),
	siteUrl: v.string(),
};

/** Send a double opt-in confirmation email. */
export async function sendDoiConfirmation(
	ctx: ActionCtx,
	args: ObjectType<typeof sendConfirmationEmailArgs>
): Promise<{ success: boolean }> {
	// Get team info for the email
	const team = await ctx.runQuery(internal.contacts.confirmationEmailQueries.getTeamInfo, {});

	const teamName = team?.name || 'Newsletter';
	// The team's own address, else the system sender; with neither the
	// scheduled action fails with the reason in the deployment logs.
	const fromEmail = team?.defaultFromEmail || requireSystemSenderAddress();
	const fromName = team?.defaultFromName || teamName;

	// Build confirmation URL
	const confirmationUrl = `${args.siteUrl}/confirm?token=${encodeURIComponent(args.confirmationToken)}`;

	// Generate email HTML
	const html = generateConfirmationEmailHtml(args.firstName, confirmationUrl, teamName);

	// Send through the configured system transport (Send system email module).
	// Routes to whatever delivery provider is configured (MTA / Resend / SES),
	// so it does not need the built-in MTA to be running.
	await ctx.runAction(internal.maintenance.systemMail.sendSystemEmail, {
		to: args.email,
		from: formatFromAddress(fromEmail, fromName),
		subject: `Confirm your subscription to ${teamName}`,
		html,
	});

	return { success: true };
}

export const sendConfirmationEmail = internalAction({
	args: sendConfirmationEmailArgs,
	handler: async (ctx, args): Promise<{ success: boolean }> => await sendDoiConfirmation(ctx, args),
});
