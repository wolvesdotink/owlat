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

/** The interface languages this product ships. */
export type SystemEmailLocale = 'en' | 'de';

/** `en` when the profile has no preference, which is the pre-existing behaviour. */
export function systemEmailLocale(locale: string | undefined): SystemEmailLocale {
	return locale === 'de' ? 'de' : 'en';
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

const DELETION_EMAIL: Record<SystemEmailLocale, DeletionEmailCopy> = {
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
		subject: 'Ihre Anfrage zur Löschung Ihres Owlat-Kontos',
		title: 'Löschung des Kontos bestätigt',
		heading: 'Kontolöschung geplant',
		scheduledFor: (date) => `Ihr Konto wird am <strong>${date}</strong> endgültig gelöscht`,
		greeting: 'Hallo,',
		received: (email) =>
			`Wir haben eine Anfrage erhalten, Ihr Owlat-Konto mit der Adresse <strong style="color: #f5f2ef;">${email}</strong> zu löschen.`,
		graceNote:
			'Ihr Konto und alle zugehörigen Daten werden nach einer Frist von 30 Tagen endgültig gelöscht. Dazu gehören:',
		deletedItems: [
			'Alle Kontakte und ihre Daten',
			'E-Mail-Vorlagen und Kampagnen',
			'Automatisierungen und Workflows',
			'Auswertungen und Berichte',
			'API-Schlüssel und Webhooks',
			'Team-Einstellungen und Konfigurationen',
		],
		changedYourMind:
			'Falls Sie diese Löschung nicht angefordert haben oder es sich anders überlegt haben, können Sie die Anfrage jederzeit vor dem Löschdatum abbrechen.',
		cta: 'Kontolöschung abbrechen',
		linkFallback: 'Oder kopieren Sie diesen Link in Ihren Browser:',
		noActionNeeded:
			'Falls Sie die Löschung angefordert haben, ist nichts weiter zu tun. Ihr Konto wird am geplanten Datum automatisch gelöscht.',
		irreversible:
			'Aus Sicherheitsgründen kann dieser Vorgang nach Ablauf der 30 Tage nicht rückgängig gemacht werden.',
		footer: 'Dies ist eine automatische E-Mail von Owlat.',
	},
};

export function deletionEmailCopy(locale: SystemEmailLocale): DeletionEmailCopy {
	return DELETION_EMAIL[locale];
}

/** The sentences the opt-in Daily Brief digest (idea 29) is made of. */
export interface DailyBriefEmailCopy {
	subject: (count: number) => string;
	heading: string;
	emptyLine: string;
	bundledLine: (total: number) => string;
}

const DAILY_BRIEF_EMAIL: Record<SystemEmailLocale, DailyBriefEmailCopy> = {
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
				? 'Ihr Tagesüberblick — 1 Sache braucht Sie'
				: `Ihr Tagesüberblick — ${count} Sachen brauchen Sie`,
		heading: 'Was heute Ihre Aufmerksamkeit braucht',
		emptyLine: 'Heute braucht Sie nichts.',
		bundledLine: (total) =>
			total === 1
				? '1 Nachricht mit geringer Relevanz wurde gebündelt und wartet in Ihrem Posteingang.'
				: `${total} Nachrichten mit geringer Relevanz wurden gebündelt und warten in Ihrem Posteingang.`,
	},
};

export function dailyBriefEmailCopy(locale: SystemEmailLocale): DailyBriefEmailCopy {
	return DAILY_BRIEF_EMAIL[locale];
}

/**
 * BCP-47 tag for `Intl`, which does not take the two-letter interface code:
 * "de" alone formats a date the German way, but naming the region keeps the
 * mail consistent with what the app renders for the same person.
 */
export function systemEmailBcp47(locale: SystemEmailLocale): string {
	return locale === 'de' ? 'de-DE' : 'en-US';
}
