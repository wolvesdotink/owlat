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
 * Above the links it carries the sender's postal address when the brand kit
 * holds one (CAN-SPAM asks for a valid postal address in commercial mail).
 *
 * The link labels follow the language the body was rendered in, through the
 * table below: this renders inside Convex, where the web app's i18n catalogs
 * are not available. A language the table lacks falls back to English.
 *
 * The anchors carry `data-no-track`, so link wrapping leaves them alone. An
 * opt-out must keep working when the tracking host does not, must not count
 * as a campaign click, and its contact token must not end up in click records
 * or `email.clicked` webhooks.
 */

import { escapeHtml } from '@owlat/shared/html';

export interface FooterUrls {
	unsubscribeUrl: string;
	preferenceUrl: string;
}

export interface FooterContent extends FooterUrls {
	/** The language the message body is in (`de`, `de-AT`, `en`, ...). */
	language?: string;
	/** The sender's company name and postal address, one line per line. */
	senderAddress?: string;
}

type FooterLanguage = 'en' | 'de';

const FOOTER_COPY: Record<FooterLanguage, { managePreferences: string; unsubscribe: string }> = {
	en: { managePreferences: 'Manage Preferences', unsubscribe: 'Unsubscribe' },
	de: { managePreferences: 'Einstellungen verwalten', unsubscribe: 'Abmelden' },
};

function footerCopy(language: string | undefined) {
	const primary = language?.trim().toLowerCase().split(/[-_]/)[0];
	return primary && primary in FOOTER_COPY
		? FOOTER_COPY[primary as FooterLanguage]
		: FOOTER_COPY.en;
}

function addressLines(senderAddress: string | undefined): string[] {
	return (senderAddress ?? '')
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

export function footerHtml({
	unsubscribeUrl,
	preferenceUrl,
	language,
	senderAddress,
}: FooterContent): string {
	const copy = footerCopy(language);
	const lines = addressLines(senderAddress);
	const address =
		lines.length > 0
			? `
  <p style="margin: 0 0 8px;">${lines.map(escapeHtml).join('<br>')}</p>`
			: '';
	return `
<div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; text-align: center; font-size: 12px; color: #6b7280;">${address}
  <p style="margin: 0;">
    <a href="${preferenceUrl}" data-no-track style="color: #6b7280; text-decoration: underline;">${copy.managePreferences}</a>
    &nbsp;&middot;&nbsp;
    <a href="${unsubscribeUrl}" data-no-track style="color: #6b7280; text-decoration: underline;">${copy.unsubscribe}</a>
  </p>
</div>`;
}

export function footerText({
	unsubscribeUrl,
	preferenceUrl,
	language,
	senderAddress,
}: FooterContent): string {
	const copy = footerCopy(language);
	const lines = addressLines(senderAddress);
	const links = `${copy.managePreferences}: ${preferenceUrl}\n${copy.unsubscribe}: ${unsubscribeUrl}`;
	return lines.length > 0 ? `${lines.join('\n')}\n\n${links}` : links;
}
