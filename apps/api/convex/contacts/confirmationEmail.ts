/**
 * The double opt-in mail a pending signup is sent to confirm its address.
 *
 * The builder's body is an exported helper, so the previous release's path
 * (`confirmationEmail.ts` at the convex root) runs the same code.
 */
import { v, type ObjectType } from 'convex/values';
import { internalAction, type ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { getOptional } from '../lib/env';
import { formatFromAddress } from '../lib/emailProviders/domainVerification';
import { generateConfirmationEmailHtml } from '../lib/systemEmails';

/** `sendConfirmationEmail`'s arguments, shared with its previous-release path. */
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
	const fromEmail =
		team?.defaultFromEmail || `noreply@${getOptional('DEFAULT_FROM_DOMAIN') || 'mail.owlat.app'}`;
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
