import { escapeHtml } from '@owlat/shared/html';

/**
 * Shared HTML shell + generators for Owlat's system / auth emails (invitation,
 * password reset, account-deletion confirmation, double-opt-in confirmation).
 *
 * They previously hand-rolled the identical dark-theme chrome (palette, card
 * table, CTA button, footer) four times. `renderSystemEmail` is the one shell;
 * each generator supplies only its title, body content and footer line. Callers
 * are responsible for escaping any untrusted values they interpolate into the
 * body/title (the generators below do, via escapeHtml).
 */
export function renderSystemEmail(opts: { title: string; body: string; footer?: string }): string {
	const footer = opts.footer ?? 'Sent by Owlat';
	return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${opts.title}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #12110e; color: #f5f2ef;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 500px; margin: 0 auto; background-color: #1a1816; border-radius: 16px; border: 1px solid #252220;">
          <tr>
            <td style="padding: 40px;">
${opts.body}
            </td>
          </tr>
        </table>

        <!-- Email footer -->
        <table role="presentation" style="max-width: 500px; margin: 24px auto 0 auto;">
          <tr>
            <td style="text-align: center;">
              <p style="margin: 0; font-size: 12px; color: #6b635a;">
                ${footer}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

/**
 * The dark-theme CTA button followed by the verbatim "Or copy and paste this
 * link…" fallback, used by every system-email generator below. They differ only
 * by the link URL and the button label, so this collapses the six identical
 * copies into one. `url` is assumed already trusted (the generators pass
 * server-built URLs, never user input); `label` is static button text.
 */
function ctaWithFallback(url: string, label: string): string {
	return `              <!-- CTA Button -->
              <table role="presentation" style="width: 100%;">
                <tr>
                  <td style="text-align: center; padding: 0 0 32px 0;">
                    <a href="${url}" style="display: inline-block; padding: 14px 32px; background-color: #c4785a; color: #ffffff; font-size: 16px; font-weight: 600; text-decoration: none; border-radius: 10px;">
                      ${label}
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Link fallback -->
              <p style="margin: 0 0 8px 0; font-size: 13px; color: #6b635a;">
                Or copy and paste this link into your browser:
              </p>
              <p style="margin: 0 0 32px 0; font-size: 13px; word-break: break-all;">
                <a href="${url}" style="color: #c4785a; text-decoration: underline;">
                  ${url}
                </a>
              </p>`;
}

/** Invitation to join an organization. */
export function generateInvitationEmailHtml(
	organizationName: string,
	inviterName: string,
	inviterEmail: string,
	acceptUrl: string,
	role: string
): string {
	// BetterAuth's wire role is 'member', but every product surface calls that
	// role 'Editor' — map to the app label so the email matches what the team page
	// (and the accept screen) show. Other roles use their capitalized wire name.
	const roleLabel = role === 'member' ? 'Editor' : role.charAt(0).toUpperCase() + role.slice(1);
	const article = /^[aeiou]/i.test(roleLabel) ? 'an' : 'a';
	const safeOrgName = escapeHtml(organizationName);
	const safeInviterName = escapeHtml(inviterName);
	const safeInviterEmail = escapeHtml(inviterEmail);
	const safeRoleLabel = escapeHtml(roleLabel);

	const body = `              <!-- Header -->
              <h1 style="margin: 0 0 8px 0; font-size: 24px; font-weight: 600; color: #f5f2ef;">
                You're invited!
              </h1>
              <p style="margin: 0 0 32px 0; color: #a09890; font-size: 14px;">
                Join ${safeOrgName} on Owlat
              </p>

              <!-- Message -->
              <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.6; color: #a09890;">
                <strong style="color: #f5f2ef;">${safeInviterName}</strong> (${safeInviterEmail}) has invited you to join <strong style="color: #f5f2ef;">${safeOrgName}</strong> as ${article} <strong style="color: #c4785a;">${safeRoleLabel}</strong>.
              </p>

              <p style="margin: 0 0 32px 0; font-size: 16px; line-height: 1.6; color: #a09890;">
                Click the button below to accept the invitation and get started.
              </p>

${ctaWithFallback(acceptUrl, 'Accept Invitation')}

              <!-- Footer note -->
              <p style="margin: 0; font-size: 13px; color: #6b635a;">
                This invitation will expire in 7 days. If you didn't expect this invitation, you can safely ignore this email.
              </p>`;

	return renderSystemEmail({ title: `You're invited to join ${safeOrgName}`, body });
}

/**
 * Invitation to join an organization AND a specific team inbox. Sent instead of
 * the generic org invite when the invitee has a reserved team-inbox membership
 * (see `mail/pendingMailbox.ts`) — it names the inbox so the person knows what
 * they're joining, and the membership is waiting for them the moment they accept.
 */
export function generateInboxInviteEmailHtml(
	organizationName: string,
	inviterName: string,
	inviterEmail: string,
	inboxAddress: string,
	acceptUrl: string
): string {
	const safeOrgName = escapeHtml(organizationName);
	const safeInviterName = escapeHtml(inviterName);
	const safeInviterEmail = escapeHtml(inviterEmail);
	const safeInbox = escapeHtml(inboxAddress);

	const body = `              <!-- Header -->
              <h1 style="margin: 0 0 8px 0; font-size: 24px; font-weight: 600; color: #f5f2ef;">
                You're invited to a team inbox
              </h1>
              <p style="margin: 0 0 32px 0; color: #a09890; font-size: 14px;">
                Join ${safeOrgName} on Owlat
              </p>

              <!-- Message -->
              <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.6; color: #a09890;">
                <strong style="color: #f5f2ef;">${safeInviterName}</strong> (${safeInviterEmail}) invited you to the shared inbox <strong style="color: #c4785a;">${safeInbox}</strong> in <strong style="color: #f5f2ef;">${safeOrgName}</strong>.
              </p>

              <p style="margin: 0 0 32px 0; font-size: 16px; line-height: 1.6; color: #a09890;">
                Accept below to create your account. The inbox will be ready and waiting in your sidebar.
              </p>

${ctaWithFallback(acceptUrl, 'Accept & join the inbox')}

              <!-- Footer note -->
              <p style="margin: 0; font-size: 13px; color: #6b635a;">
                This invitation will expire in 7 days. If you didn't expect this invitation, you can safely ignore this email.
              </p>`;

	return renderSystemEmail({ title: `You're invited to ${safeInbox} on Owlat`, body });
}

/** Password reset. */
export function generatePasswordResetEmailHtml(userName: string, resetUrl: string): string {
	const safeName = escapeHtml(userName);

	const body = `              <!-- Header -->
              <h1 style="margin: 0 0 8px 0; font-size: 24px; font-weight: 600; color: #f5f2ef;">
                Reset your password
              </h1>
              <p style="margin: 0 0 32px 0; color: #a09890; font-size: 14px;">
                Hi ${safeName}
              </p>

              <!-- Message -->
              <p style="margin: 0 0 32px 0; font-size: 16px; line-height: 1.6; color: #a09890;">
                We received a request to reset the password for your account. Click the button below to choose a new password.
              </p>

${ctaWithFallback(resetUrl, 'Reset Password')}

              <!-- Footer note -->
              <p style="margin: 0; font-size: 13px; color: #6b635a;">
                This link will expire in 1 hour. If you didn't request this, you can safely ignore this email.
              </p>`;

	return renderSystemEmail({ title: 'Reset your password', body });
}

/** Change-of-login-email confirmation, step 1. Sent to the CURRENT address so
 * only the account owner can approve moving the login email to a new address.
 * Following the link does NOT yet change the email — it triggers a second
 * verification email to the NEW address (see generateNewEmailVerificationHtml),
 * and only following THAT link commits the change. */
export function generateChangeEmailVerificationHtml(
	userName: string,
	newEmail: string,
	verifyUrl: string
): string {
	const safeName = escapeHtml(userName);
	const safeNewEmail = escapeHtml(newEmail);

	const body = `              <!-- Header -->
              <h1 style="margin: 0 0 8px 0; font-size: 24px; font-weight: 600; color: #f5f2ef;">
                Confirm your new email
              </h1>
              <p style="margin: 0 0 32px 0; color: #a09890; font-size: 14px;">
                Hi ${safeName}
              </p>

              <!-- Message -->
              <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.6; color: #a09890;">
                We received a request to change the email you use to sign in to <strong style="color: #f5f2ef;">${safeNewEmail}</strong>. Click the button below to approve the change.
              </p>
              <p style="margin: 0 0 32px 0; font-size: 16px; line-height: 1.6; color: #a09890;">
                We'll then send a final confirmation link to ${safeNewEmail}. Your login email stays the same until that link is followed.
              </p>

${ctaWithFallback(verifyUrl, 'Approve email change')}

              <!-- Footer note -->
              <p style="margin: 0; font-size: 13px; color: #6b635a;">
                If you didn't request this change, you can safely ignore this email and your login email will not change.
              </p>`;

	return renderSystemEmail({ title: 'Confirm your new email', body });
}

/** Change-of-login-email verification, final step. Sent to the NEW address.
 * BetterAuth's change-email flow delivers this through
 * emailVerification.sendVerificationEmail — for verified accounts it is the
 * second hop (after the current-address approval), and for unverified accounts
 * it is the only hop. Following the link is what actually commits the new login
 * email and marks it verified. */
export function generateNewEmailVerificationHtml(
	userName: string,
	newEmail: string,
	verifyUrl: string
): string {
	const safeName = escapeHtml(userName);
	const safeNewEmail = escapeHtml(newEmail);

	const body = `              <!-- Header -->
              <h1 style="margin: 0 0 8px 0; font-size: 24px; font-weight: 600; color: #f5f2ef;">
                Verify your new login email
              </h1>
              <p style="margin: 0 0 32px 0; color: #a09890; font-size: 14px;">
                Hi ${safeName}
              </p>

              <!-- Message -->
              <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.6; color: #a09890;">
                You're almost done. Click the button below to confirm <strong style="color: #f5f2ef;">${safeNewEmail}</strong> and start using it to sign in to Owlat.
              </p>
              <p style="margin: 0 0 32px 0; font-size: 16px; line-height: 1.6; color: #a09890;">
                Your login email only changes once you follow this link.
              </p>

${ctaWithFallback(verifyUrl, 'Verify new email')}

              <!-- Footer note -->
              <p style="margin: 0; font-size: 13px; color: #6b635a;">
                If you didn't request this change, you can safely ignore this email and your login email will not change.
              </p>`;

	return renderSystemEmail({ title: 'Verify your new login email', body });
}

/** Account-deletion confirmation (carries the cancel link). */
export function generateDeletionEmailHtml(
	email: string,
	scheduledDate: string,
	cancelUrl: string
): string {
	const body = `              <!-- Header with warning -->
              <div style="margin: 0 0 24px 0; padding: 16px; background-color: #1e1514; border-radius: 12px; border: 1px solid #c46b5a;">
                <h1 style="margin: 0 0 8px 0; font-size: 20px; font-weight: 600; color: #c46b5a;">
                  ⚠️ Account Deletion Scheduled
                </h1>
                <p style="margin: 0; color: #c46b5a; font-size: 14px;">
                  Your account will be permanently deleted on <strong>${scheduledDate}</strong>
                </p>
              </div>

              <!-- Message -->
              <p style="margin: 0 0 16px 0; font-size: 16px; color: #f5f2ef;">
                Hi,
              </p>
              <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.6; color: #a09890;">
                We received a request to delete your Owlat account associated with <strong style="color: #f5f2ef;">${email}</strong>.
              </p>
              <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 1.6; color: #a09890;">
                Your account and all associated data will be permanently deleted after a 30-day grace period. This includes:
              </p>

              <!-- What will be deleted -->
              <ul style="margin: 0 0 24px 0; padding-left: 24px; color: #a09890; font-size: 14px; line-height: 1.8;">
                <li>All contacts and their data</li>
                <li>Email templates and campaigns</li>
                <li>Automations and workflows</li>
                <li>Analytics and reports</li>
                <li>API keys and webhooks</li>
                <li>Team settings and configurations</li>
              </ul>

              <p style="margin: 0 0 24px 0; font-size: 16px; line-height: 1.6; color: #a09890;">
                If you didn't request this deletion or have changed your mind, you can cancel this request at any time before the deletion date.
              </p>

${ctaWithFallback(cancelUrl, 'Cancel Account Deletion')}

              <!-- Footer note -->
              <div style="padding-top: 24px; border-top: 1px solid #252220;">
                <p style="margin: 0 0 8px 0; font-size: 13px; color: #6b635a;">
                  If you did request this deletion, no action is needed. Your account will be automatically deleted on the scheduled date.
                </p>
                <p style="margin: 0; font-size: 13px; color: #6b635a;">
                  For security reasons, this action cannot be undone after the 30-day period.
                </p>
              </div>`;

	return renderSystemEmail({
		title: 'Account Deletion Request Confirmed',
		body,
		footer: 'This is an automated email from Owlat',
	});
}

/** Double-opt-in subscription confirmation. */
export function generateConfirmationEmailHtml(
	firstName: string | undefined,
	confirmationUrl: string,
	teamName: string
): string {
	const safeTeamName = escapeHtml(teamName);
	const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi,';

	const body = `              <!-- Header -->
              <h1 style="margin: 0 0 8px 0; font-size: 24px; font-weight: 600; color: #f5f2ef;">
                Confirm your subscription
              </h1>
              <p style="margin: 0 0 32px 0; color: #a09890; font-size: 14px;">
                ${safeTeamName}
              </p>

              <!-- Greeting -->
              <p style="margin: 0 0 16px 0; font-size: 16px; color: #f5f2ef;">
                ${greeting}
              </p>

              <!-- Message -->
              <p style="margin: 0 0 32px 0; font-size: 16px; line-height: 1.6; color: #a09890;">
                Thank you for signing up! Please confirm your email address by clicking the button below to complete your subscription.
              </p>

${ctaWithFallback(confirmationUrl, 'Confirm subscription')}

              <!-- Footer note -->
              <p style="margin: 0; font-size: 13px; color: #6b635a;">
                If you didn't request this email, you can safely ignore it.
              </p>`;

	return renderSystemEmail({
		title: 'Confirm your subscription',
		body,
		footer: `Sent by Owlat on behalf of ${safeTeamName}`,
	});
}
