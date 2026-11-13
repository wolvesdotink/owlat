/**
 * Send composition (module) — the unsubscribe footer.
 *
 * Every marketing message carries it (campaigns of any audience, automation
 * email steps), and transactional mail carries it when its template opts in.
 * Gmail's and Yahoo's bulk-sender rules and CAN-SPAM ask for a visible opt-out
 * in the body on top of the RFC 8058 header pair, so the footer is rendered
 * into both the html and the text/plain part.
 *
 * The copy names no topic: the unsubscribe link is contact-scoped, so the same
 * footer is correct for a topic campaign, a computed segment and an automation.
 *
 * The anchors carry `data-no-track`, so link wrapping leaves them alone. An
 * opt-out must keep working when the tracking host does not, must not count
 * as a campaign click, and its contact token must not end up in click records
 * or `email.clicked` webhooks.
 */

export interface FooterUrls {
	unsubscribeUrl: string;
	preferenceUrl: string;
}

export function footerHtml({ unsubscribeUrl, preferenceUrl }: FooterUrls): string {
	return `
<div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; text-align: center; font-size: 12px; color: #6b7280;">
  <p style="margin: 0;">
    <a href="${preferenceUrl}" data-no-track style="color: #6b7280; text-decoration: underline;">Manage Preferences</a>
    &nbsp;&middot;&nbsp;
    <a href="${unsubscribeUrl}" data-no-track style="color: #6b7280; text-decoration: underline;">Unsubscribe</a>
  </p>
</div>`;
}

export function footerText({ unsubscribeUrl, preferenceUrl }: FooterUrls): string {
	return `Manage Preferences: ${preferenceUrl}\nUnsubscribe: ${unsubscribeUrl}`;
}
