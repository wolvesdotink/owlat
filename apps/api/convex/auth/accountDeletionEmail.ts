/**
 * The mail that confirms a scheduled account deletion and carries its
 * cancellation link.
 */
import { v, type ObjectType } from 'convex/values';
import { internalAction, type ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { getOptional } from '../lib/env';
import { generateDeletionEmailHtml } from '../lib/systemEmails';
import { deletionEmailCopy, systemEmailBcp47, systemEmailLocale } from '../lib/systemEmailCopy';
import { appLocaleValidator } from '../lib/convexValidators';

/** `sendAccountDeletionEmail`'s arguments. */
export const sendAccountDeletionEmailArgs = {
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
};

/** Send account deletion confirmation email. */
export async function sendDeletionConfirmation(
	ctx: ActionCtx,
	args: ObjectType<typeof sendAccountDeletionEmailArgs>
): Promise<{ success: boolean }> {
	const locale = systemEmailLocale(args.locale);
	const copy = deletionEmailCopy(locale);
	// The date said the reader's way: "Sunday, June 15, 2025" against
	// "Sonntag, 15. Juni 2025". A fixed `'en-US'` would tell a German
	// account the deletion date in a format it has to decode.
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
	await ctx.runAction(internal.maintenance.systemMail.sendSystemEmail, {
		to: args.email,
		from: `Owlat <noreply@${getOptional('DEFAULT_FROM_DOMAIN') || 'mail.owlat.app'}>`,
		subject: copy.subject,
		html,
	});

	return { success: true };
}

export const sendAccountDeletionEmail = internalAction({
	args: sendAccountDeletionEmailArgs,
	handler: async (ctx, args) => await sendDeletionConfirmation(ctx, args),
});
