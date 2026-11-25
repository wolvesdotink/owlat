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
 * The link labels, and the view-in-browser link's, follow the language the
 * body was rendered in, through the table below: this renders inside Convex,
 * where the web app's i18n catalogs are not available. The table is keyed by
 * the primary language subtag, so one entry serves every region (`pt` reads
 * right in Portugal and Brazil, `de` in Austria). A language the table lacks
 * falls back to English.
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

type FooterLanguage = 'en' | 'de' | 'fr' | 'es' | 'it' | 'nl' | 'pt';

interface FooterCopy {
	managePreferences: string;
	unsubscribe: string;
	viewInBrowser: string;
}

const FOOTER_COPY: Record<FooterLanguage, FooterCopy> = {
	en: {
		managePreferences: 'Manage Preferences',
		unsubscribe: 'Unsubscribe',
		viewInBrowser: 'View in browser',
	},
	de: {
		managePreferences: 'Einstellungen verwalten',
		unsubscribe: 'Abmelden',
		viewInBrowser: 'Im Browser ansehen',
	},
	fr: {
		managePreferences: 'Gérer mes préférences',
		unsubscribe: 'Se désabonner',
		viewInBrowser: 'Voir dans le navigateur',
	},
	es: {
		managePreferences: 'Gestionar preferencias',
		unsubscribe: 'Darse de baja',
		viewInBrowser: 'Ver en el navegador',
	},
	it: {
		managePreferences: 'Gestisci preferenze',
		unsubscribe: 'Annulla iscrizione',
		viewInBrowser: 'Visualizza nel browser',
	},
	nl: {
		managePreferences: 'Voorkeuren beheren',
		unsubscribe: 'Uitschrijven',
		viewInBrowser: 'Bekijk in browser',
	},
	// Worded to read right in both Portugal and Brazil, which name "manage"
	// differently (gerir, gerenciar).
	pt: {
		managePreferences: 'Alterar preferências',
		unsubscribe: 'Cancelar inscrição',
		viewInBrowser: 'Ver no navegador',
	},
};

/**
 * The labels for a body language. Own keys only, so a language tag that names
 * an `Object.prototype` member (`constructor`) falls back to English too.
 */
function footerCopy(language: string | undefined): FooterCopy {
	const primary = language?.trim().toLowerCase().split(/[-_]/)[0];
	return primary && Object.prototype.hasOwnProperty.call(FOOTER_COPY, primary)
		? FOOTER_COPY[primary as FooterLanguage]
		: FOOTER_COPY.en;
}

export function addressLines(senderAddress: string | undefined): string[] {
	return (senderAddress ?? '')
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

/** The view-in-browser link the top of a campaign carries, labelled like the footer. */
export function viewInBrowserHtml(url: string, language: string | undefined): string {
	return `<div style="text-align:center;font-size:11px;color:#999;padding:8px 0 4px"><a href="${url}" data-no-track style="color:#999;text-decoration:underline">${footerCopy(language).viewInBrowser}</a></div>`;
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
