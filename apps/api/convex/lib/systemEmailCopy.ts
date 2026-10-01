/**
 * COPY FOR SYSTEM EMAILS, IN THE LANGUAGE THE RECIPIENT CHOSE.
 *
 * The web app's message catalogs (`apps/web/i18n/locales/*.json`) belong to the
 * browser bundle and to vue-i18n; the Convex backend cannot reach either, and a
 * system email is composed here, on a scheduler, with no request and no cookie
 * behind it. So the sentences a system email is made of live in this module,
 * beside the generators that use them.
 *
 * The recipient's language comes from `userProfiles.locale`, written by the
 * language picker. ABSENT MEANS ENGLISH — which is what every account got
 * before that field existed, so nobody's mail changes language until they
 * touch the picker.
 *
 * The account-deletion mail and the daily-brief digest are translated. The six
 * generators in `systemEmails.ts` still ship English; see
 * `docs/ux-plan/DEFERRALS.md`.
 */

import { APP_LOCALE_BCP47, isAppLocale, type AppLocale } from '@owlat/shared/appLocales';

/**
 * `en` when the profile has no preference (the pre-existing behaviour) or a
 * code this product does not ship; otherwise the recipient's own language.
 */
export function systemEmailLocale(locale: string | undefined): AppLocale {
	return isAppLocale(locale) ? locale : 'en';
}

/** The sentences one system email is built from. */
export interface DeletionEmailCopy {
	subject: string;
	title: string;
	heading: string;
	scheduledFor: (date: string) => string;
	greeting: string;
	received: (email: string) => string;
	graceNote: string;
	deletedItems: readonly string[];
	changedYourMind: string;
	cta: string;
	linkFallback: string;
	noActionNeeded: string;
	irreversible: string;
	footer: string;
}

const DELETION_EMAIL: Record<AppLocale, DeletionEmailCopy> = {
	en: {
		subject: 'Your Owlat Account Deletion Request',
		title: 'Account Deletion Request Confirmed',
		heading: 'Account Deletion Scheduled',
		scheduledFor: (date) => `Your account will be permanently deleted on <strong>${date}</strong>`,
		greeting: 'Hi,',
		received: (email) =>
			`We received a request to delete your Owlat account associated with <strong style="color: #f5f2ef;">${email}</strong>.`,
		graceNote:
			'Your account and all associated data will be permanently deleted after a 30-day grace period. This includes:',
		deletedItems: [
			'All contacts and their data',
			'Email templates and campaigns',
			'Automations and workflows',
			'Analytics and reports',
			'API keys and webhooks',
			'Team settings and configurations',
		],
		changedYourMind:
			"If you didn't request this deletion or have changed your mind, you can cancel this request at any time before the deletion date.",
		cta: 'Cancel Account Deletion',
		linkFallback: 'Or copy and paste this link into your browser:',
		noActionNeeded:
			'If you did request this deletion, no action is needed. Your account will be automatically deleted on the scheduled date.',
		irreversible: 'For security reasons, this action cannot be undone after the 30-day period.',
		footer: 'This is an automated email from Owlat',
	},
	de: {
		subject: 'Deine Anfrage zur Löschung deines Owlat-Kontos',
		title: 'Löschung des Kontos bestätigt',
		heading: 'Kontolöschung geplant',
		scheduledFor: (date) => `Dein Konto wird am <strong>${date}</strong> endgültig gelöscht`,
		greeting: 'Hallo,',
		received: (email) =>
			`Wir haben eine Anfrage erhalten, dein Owlat-Konto mit der Adresse <strong style="color: #f5f2ef;">${email}</strong> zu löschen.`,
		graceNote:
			'Dein Konto und alle zugehörigen Daten werden nach einer Frist von 30 Tagen endgültig gelöscht. Dazu gehören:',
		deletedItems: [
			'Alle Kontakte und ihre Daten',
			'E-Mail-Vorlagen und Kampagnen',
			'Automatisierungen und Workflows',
			'Auswertungen und Berichte',
			'API-Schlüssel und Webhooks',
			'Team-Einstellungen und Konfigurationen',
		],
		changedYourMind:
			'Falls du diese Löschung nicht angefordert hast oder es dir anders überlegt hast, kannst du die Anfrage jederzeit vor dem Löschdatum abbrechen.',
		cta: 'Kontolöschung abbrechen',
		linkFallback: 'Oder kopiere diesen Link in deinen Browser:',
		noActionNeeded:
			'Falls du die Löschung angefordert hast, ist nichts weiter zu tun. Dein Konto wird am geplanten Datum automatisch gelöscht.',
		irreversible:
			'Aus Sicherheitsgründen kann dieser Vorgang nach Ablauf der 30 Tage nicht rückgängig gemacht werden.',
		footer: 'Dies ist eine automatische E-Mail von Owlat.',
	},
};

export function deletionEmailCopy(locale: AppLocale): DeletionEmailCopy {
	return DELETION_EMAIL[locale];
}

/** The sentences the opt-in Daily Brief digest (idea 29) is made of. */
interface DailyBriefEmailCopy {
	subject: (count: number) => string;
	heading: string;
	emptyLine: string;
	bundledLine: (total: number) => string;
}

const DAILY_BRIEF_EMAIL: Record<AppLocale, DailyBriefEmailCopy> = {
	en: {
		subject: (count) =>
			count === 1
				? 'Your daily brief — 1 thing needs you'
				: `Your daily brief — ${count} things need you`,
		heading: 'What needs you today',
		emptyLine: 'Nothing needs you today.',
		bundledLine: (total) =>
			total === 1
				? '1 low-signal message was bundled away and is waiting in your inbox.'
				: `${total} low-signal messages were bundled away and are waiting in your inbox.`,
	},
	de: {
		subject: (count) =>
			count === 1
				? 'Dein Tagesüberblick — 1 Sache braucht dich'
				: `Dein Tagesüberblick — ${count} Sachen brauchen dich`,
		heading: 'Was heute deine Aufmerksamkeit braucht',
		emptyLine: 'Heute braucht dich nichts.',
		bundledLine: (total) =>
			total === 1
				? '1 Nachricht mit geringer Relevanz wurde gebündelt und wartet in deinem Posteingang.'
				: `${total} Nachrichten mit geringer Relevanz wurden gebündelt und warten in deinem Posteingang.`,
	},
};

export function dailyBriefEmailCopy(locale: AppLocale): DailyBriefEmailCopy {
	return DAILY_BRIEF_EMAIL[locale];
}

/**
 * BCP-47 tag for `Intl`, which does not take the two-letter interface code:
 * "de" alone formats a date the German way, but naming the region keeps the
 * mail consistent with what the app renders for the same person.
 */
export function systemEmailBcp47(locale: AppLocale): string {
	return APP_LOCALE_BCP47[locale];
}
