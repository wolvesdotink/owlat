/**
 * Autodiscover IMAP/SMTP server settings from an email address, for the unified
 * mail-import wizard (`postbox/migrate.vue`).
 *
 * The wizard's provider picker ({@link MAIL_PROVIDERS}) offers a handful of
 * one-click providers, but for the generic IMAP path the user types a bare
 * address. `presetForEmail` matches its domain against a small, curated table
 * of the big consumer providers (Gmail, Outlook.com, iCloud, Fastmail, Yahoo):
 * instant, offline, no network.
 *
 * Any other domain is looked up by the backend
 * (`mail/external/autodiscoverActions.ts`), never from here: the web app's CSP
 * lets the browser reach no third-party endpoint, so a browser-side fetch of
 * an autoconfig document would never answer.
 */

import { MailIcon, ServerIcon, type IconComponent } from '@coolicons/vue';

/** The subset of connect-form server fields a preset fills. */
export type MailPreset = {
	imapHost: string;
	imapPort: number;
	isImapSecure: boolean;
	smtpHost: string;
	smtpPort: number;
	isSmtpSecure: boolean;
};

/**
 * Curated domain → preset table for the big consumer providers. The wizard's
 * provider picker ({@link MAIL_PROVIDERS}) reuses these same entries, so the
 * one-click cards and the type-ahead autodiscover can never disagree.
 */
const DOMAIN_PRESETS: Record<string, MailPreset> = {
	// Gmail / Google Workspace consumer domains.
	'gmail.com': {
		imapHost: 'imap.gmail.com',
		imapPort: 993,
		isImapSecure: true,
		smtpHost: 'smtp.gmail.com',
		smtpPort: 465,
		isSmtpSecure: true,
	},
	'googlemail.com': {
		imapHost: 'imap.gmail.com',
		imapPort: 993,
		isImapSecure: true,
		smtpHost: 'smtp.gmail.com',
		smtpPort: 465,
		isSmtpSecure: true,
	},
	// Microsoft consumer domains.
	'outlook.com': {
		imapHost: 'outlook.office365.com',
		imapPort: 993,
		isImapSecure: true,
		smtpHost: 'smtp-mail.outlook.com',
		smtpPort: 587,
		isSmtpSecure: false,
	},
	'hotmail.com': {
		imapHost: 'outlook.office365.com',
		imapPort: 993,
		isImapSecure: true,
		smtpHost: 'smtp-mail.outlook.com',
		smtpPort: 587,
		isSmtpSecure: false,
	},
	'live.com': {
		imapHost: 'outlook.office365.com',
		imapPort: 993,
		isImapSecure: true,
		smtpHost: 'smtp-mail.outlook.com',
		smtpPort: 587,
		isSmtpSecure: false,
	},
	// Apple iCloud domains.
	'icloud.com': {
		imapHost: 'imap.mail.me.com',
		imapPort: 993,
		isImapSecure: true,
		smtpHost: 'smtp.mail.me.com',
		smtpPort: 587,
		isSmtpSecure: false,
	},
	'me.com': {
		imapHost: 'imap.mail.me.com',
		imapPort: 993,
		isImapSecure: true,
		smtpHost: 'smtp.mail.me.com',
		smtpPort: 587,
		isSmtpSecure: false,
	},
	'mac.com': {
		imapHost: 'imap.mail.me.com',
		imapPort: 993,
		isImapSecure: true,
		smtpHost: 'smtp.mail.me.com',
		smtpPort: 587,
		isSmtpSecure: false,
	},
	// Fastmail (and its common aliases).
	'fastmail.com': {
		imapHost: 'imap.fastmail.com',
		imapPort: 993,
		isImapSecure: true,
		smtpHost: 'smtp.fastmail.com',
		smtpPort: 465,
		isSmtpSecure: true,
	},
	'fastmail.fm': {
		imapHost: 'imap.fastmail.com',
		imapPort: 993,
		isImapSecure: true,
		smtpHost: 'smtp.fastmail.com',
		smtpPort: 465,
		isSmtpSecure: true,
	},
	// Yahoo Mail (and its common aliases).
	'yahoo.com': {
		imapHost: 'imap.mail.yahoo.com',
		imapPort: 993,
		isImapSecure: true,
		smtpHost: 'smtp.mail.yahoo.com',
		smtpPort: 465,
		isSmtpSecure: true,
	},
	'ymail.com': {
		imapHost: 'imap.mail.yahoo.com',
		imapPort: 993,
		isImapSecure: true,
		smtpHost: 'smtp.mail.yahoo.com',
		smtpPort: 465,
		isSmtpSecure: true,
	},
	'yahoo.co.uk': {
		imapHost: 'imap.mail.yahoo.com',
		imapPort: 993,
		isImapSecure: true,
		smtpHost: 'smtp.mail.yahoo.com',
		smtpPort: 465,
		isSmtpSecure: true,
	},
};

/** Extract the lower-cased domain part of an email address, or `null`. */
export function domainOfEmail(email: string): string | null {
	const at = email.lastIndexOf('@');
	if (at <= 0 || at === email.length - 1) return null;
	const domain = email
		.slice(at + 1)
		.trim()
		.toLowerCase();
	// Reject anything that isn't a plausible dotted hostname.
	if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
	return domain;
}

/**
 * Return the curated preset for the email's domain, or `null` when the domain
 * is unknown / the address is malformed. Pure and synchronous — no network.
 */
export function presetForEmail(email: string): MailPreset | null {
	const domain = domainOfEmail(email);
	if (!domain) return null;
	return DOMAIN_PRESETS[domain] ?? null;
}

/**
 * Actionable app-password guidance for a consumer provider. The big providers
 * reject a plain account password over IMAP/SMTP once 2-factor is on and demand
 * a provider-generated "app password" instead — the single most common reason a
 * mailbox connection fails with an auth error. `url` deep-links straight to the
 * page where the user mints that password.
 */
export type AppPasswordHelp = {
	/** Human-readable provider name for the callout heading. */
	provider: string;
	/** Deep link to the provider's app-password page. */
	url: string;
	/** Catalog key for the one concise line describing how to mint the app password. */
	steps: string;
};

/**
 * Curated domain → app-password help for the consumer providers that require an
 * app password (not the account password) for IMAP/SMTP. Deep links are static.
 *
 * This table is module scope and never calls `useI18n`, so `steps` is the
 * CATALOG KEY of the sentence rather than the sentence; the callout that renders
 * it is the boundary that words it. `provider` stays the literal brand name — it
 * is interpolated into the heading, and a brand is the same in every language.
 */
const APP_PASSWORD_PROVIDERS: Record<string, AppPasswordHelp> = {
	// Google — requires 2-Step Verification, then a generated app password.
	'gmail.com': {
		provider: 'Gmail',
		url: 'https://myaccount.google.com/apppasswords',
		steps: 'shared.mailAutodiscover.appPassword.gmail',
	},
	'googlemail.com': {
		provider: 'Gmail',
		url: 'https://myaccount.google.com/apppasswords',
		steps: 'shared.mailAutodiscover.appPassword.gmail',
	},
	// Microsoft consumer accounts.
	'outlook.com': {
		provider: 'Outlook',
		url: 'https://account.live.com/proofs/AppPassword',
		steps: 'shared.mailAutodiscover.appPassword.outlook',
	},
	'hotmail.com': {
		provider: 'Outlook',
		url: 'https://account.live.com/proofs/AppPassword',
		steps: 'shared.mailAutodiscover.appPassword.outlook',
	},
	'live.com': {
		provider: 'Outlook',
		url: 'https://account.live.com/proofs/AppPassword',
		steps: 'shared.mailAutodiscover.appPassword.outlook',
	},
	// Apple iCloud Mail.
	'icloud.com': {
		provider: 'iCloud',
		url: 'https://appleid.apple.com/account/manage',
		steps: 'shared.mailAutodiscover.appPassword.icloud',
	},
	'me.com': {
		provider: 'iCloud',
		url: 'https://appleid.apple.com/account/manage',
		steps: 'shared.mailAutodiscover.appPassword.icloud',
	},
	'mac.com': {
		provider: 'iCloud',
		url: 'https://appleid.apple.com/account/manage',
		steps: 'shared.mailAutodiscover.appPassword.icloud',
	},
	// Yahoo Mail.
	'yahoo.com': {
		provider: 'Yahoo',
		url: 'https://login.yahoo.com/account/security/app-passwords',
		steps: 'shared.mailAutodiscover.appPassword.yahoo',
	},
	'ymail.com': {
		provider: 'Yahoo',
		url: 'https://login.yahoo.com/account/security/app-passwords',
		steps: 'shared.mailAutodiscover.appPassword.yahoo',
	},
	'yahoo.co.uk': {
		provider: 'Yahoo',
		url: 'https://login.yahoo.com/account/security/app-passwords',
		steps: 'shared.mailAutodiscover.appPassword.yahoo',
	},
};

/**
 * A mail provider the unified import wizard offers as a one-click starting
 * point. A provider with a `preset` fills the IMAP/SMTP servers for the user;
 * the generic `imap` provider has none, so the user types the server settings
 * themselves. `appPassword` carries actionable app-password guidance keyed by
 * provider rather than by domain, so a company Gmail (you@acme.com) still gets
 * Gmail's app-password steps.
 */
export type MailProviderId = 'gmail' | 'outlook' | 'fastmail' | 'icloud' | 'yahoo' | 'imap';

export type MailProvider = {
	id: MailProviderId;
	/** Catalog key for the name shown on the picker card. */
	name: string;
	/** The icon on the picker card. */
	icon: IconComponent;
	/** Catalog key for the one concise line under the name (the server, or a plain hint). */
	hint: string;
	/** Server preset, or `null` for the generic IMAP provider (manual entry). */
	preset: MailPreset | null;
	/** App-password guidance, or `null` when the provider needs no app password. */
	appPassword: AppPasswordHelp | null;
	/**
	 * The OAuth provider this mailbox can be connected with instead of an app
	 * password, or `null` when the only route in is a password. Set means the
	 * connect form MAY offer the provider's sign-in button — it still asks the
	 * backend whether this instance has an OAuth client configured, and falls
	 * back to the app-password form when it has not.
	 */
	oauth: { provider: 'google' | 'microsoft' } | null;
	/** Whether the user must fill in the IMAP/SMTP servers by hand. */
	manualServer: boolean;
};

/**
 * The generic "any IMAP mailbox" provider: no preset (the user types the server
 * settings, autodiscovered from the domain), no app-password deep link. Exported
 * so callers that need the always-present fallback provider don't reach for it
 * via `providerById('imap')` with a non-null cast.
 */
export const GENERIC_IMAP_PROVIDER: MailProvider = {
	id: 'imap',
	name: 'shared.mailAutodiscover.provider.imap.name',
	icon: ServerIcon,
	hint: 'shared.mailAutodiscover.provider.imap.hint',
	preset: null,
	appPassword: null,
	oauth: null,
	manualServer: true,
};

/**
 * The curated provider list the import wizard shows, in the order they appear.
 * Presets reuse the domain table above so the picker and autodiscover never
 * disagree; the generic IMAP entry is always last.
 */
export const MAIL_PROVIDERS: readonly MailProvider[] = [
	{
		id: 'gmail',
		name: 'shared.mailAutodiscover.provider.gmail.name',
		icon: MailIcon,
		hint: 'shared.mailAutodiscover.provider.gmail.hint',
		preset: DOMAIN_PRESETS['gmail.com'] ?? null,
		appPassword: APP_PASSWORD_PROVIDERS['gmail.com'] ?? null,
		// Google deprecates password auth for IMAP; OAuth is what it asks for.
		oauth: { provider: 'google' },
		manualServer: false,
	},
	{
		id: 'outlook',
		name: 'shared.mailAutodiscover.provider.outlook.name',
		icon: MailIcon,
		hint: 'shared.mailAutodiscover.provider.outlook.hint',
		preset: DOMAIN_PRESETS['outlook.com'] ?? null,
		appPassword: APP_PASSWORD_PROVIDERS['outlook.com'] ?? null,
		// Microsoft is retiring basic auth for IMAP/SMTP, and many tenants refuse
		// app passwords already.
		oauth: { provider: 'microsoft' },
		manualServer: false,
	},
	{
		id: 'fastmail',
		name: 'shared.mailAutodiscover.provider.fastmail.name',
		icon: MailIcon,
		hint: 'shared.mailAutodiscover.provider.fastmail.hint',
		preset: DOMAIN_PRESETS['fastmail.com'] ?? null,
		appPassword: {
			provider: 'Fastmail',
			url: 'https://app.fastmail.com/settings/security/apppasswords',
			steps: 'shared.mailAutodiscover.appPassword.fastmail',
		},
		oauth: null,
		manualServer: false,
	},
	{
		id: 'icloud',
		name: 'shared.mailAutodiscover.provider.icloud.name',
		icon: MailIcon,
		hint: 'shared.mailAutodiscover.provider.icloud.hint',
		preset: DOMAIN_PRESETS['icloud.com'] ?? null,
		appPassword: APP_PASSWORD_PROVIDERS['icloud.com'] ?? null,
		oauth: null,
		manualServer: false,
	},
	{
		id: 'yahoo',
		name: 'shared.mailAutodiscover.provider.yahoo.name',
		icon: MailIcon,
		hint: 'shared.mailAutodiscover.provider.yahoo.hint',
		preset: DOMAIN_PRESETS['yahoo.com'] ?? null,
		appPassword: APP_PASSWORD_PROVIDERS['yahoo.com'] ?? null,
		oauth: null,
		manualServer: false,
	},
	GENERIC_IMAP_PROVIDER,
];

/** Look up a provider by id, or `undefined` for an unknown id. */
export function providerById(id: string): MailProvider | undefined {
	return MAIL_PROVIDERS.find((p) => p.id === id);
}

/**
 * The guided provider whose preset matches a CONNECTED account's IMAP host, or
 * the generic IMAP one. Lets an existing account's edit/reconnect form carry
 * the right guidance (Gmail's Google sign-in, a provider's app-password steps)
 * without the account having to remember which card it was created from.
 */
export function providerForImapHost(host: string | null | undefined): MailProvider {
	const needle = (host ?? '').toLowerCase();
	const match = MAIL_PROVIDERS.find((p) => p.preset?.imapHost.toLowerCase() === needle);
	return match ?? GENERIC_IMAP_PROVIDER;
}

/** The IMAP/SMTP preset for a provider id, or `null` (generic IMAP / unknown). */
export function providerPreset(id: string): MailPreset | null {
	return providerById(id)?.preset ?? null;
}
