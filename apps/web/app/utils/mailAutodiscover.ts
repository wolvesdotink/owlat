/**
 * Autodiscover IMAP/SMTP server settings from an email address
 * (Settings → Connect external mailbox).
 *
 * The external-account form already ships a handful of provider presets, but
 * the user has to know which button to click. This module derives the same
 * preset shape straight from the email DOMAIN so the server fields can be
 * pre-filled as the address is typed:
 *
 *  - `presetForEmail` matches the domain against a small, curated table of the
 *    big consumer providers (Gmail, Outlook.com, iCloud, Fastmail) — instant,
 *    offline, no network.
 *  - `autodiscover` is an optional FAIL-SOFT fallback for unknown domains: it
 *    queries the Thunderbird autoconfig service (used by every mainstream mail
 *    client) over HTTPS and parses the returned IMAP/SMTP host/port/socketType.
 *
 * Fail-soft by design, modelled on `spfCoexistence.ts`: any network / parse /
 * timeout error resolves to `null` (the user just fills the fields manually) —
 * a lookup hiccup must never throw into the settings UI. Request hosts are
 * fixed; the domain is only ever interpolated as an encoded path/query value.
 */

/** The subset of the external-account form a preset fills. Mirrors PRESETS there. */
export type MailPreset = {
	imapHost: string;
	imapPort: number;
	isImapSecure: boolean;
	smtpHost: string;
	smtpPort: number;
	isSmtpSecure: boolean;
};

/**
 * Curated domain → preset table for the big consumer providers. Values match
 * the manual PRESETS in external-account.vue so autofill and the buttons agree.
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
	/** One concise line describing how to mint the app password. */
	steps: string;
};

/**
 * Curated domain → app-password help for the consumer providers that require an
 * app password (not the account password) for IMAP/SMTP. Deep links are static.
 */
const APP_PASSWORD_PROVIDERS: Record<string, AppPasswordHelp> = {
	// Google — requires 2-Step Verification, then a generated app password.
	'gmail.com': {
		provider: 'Gmail',
		url: 'https://myaccount.google.com/apppasswords',
		steps:
			'Turn on 2-Step Verification, then generate a 16-character app password and paste it here.',
	},
	'googlemail.com': {
		provider: 'Gmail',
		url: 'https://myaccount.google.com/apppasswords',
		steps:
			'Turn on 2-Step Verification, then generate a 16-character app password and paste it here.',
	},
	// Microsoft consumer accounts.
	'outlook.com': {
		provider: 'Outlook',
		url: 'https://account.live.com/proofs/AppPassword',
		steps: 'Turn on two-step verification, create an app password and paste it here.',
	},
	'hotmail.com': {
		provider: 'Outlook',
		url: 'https://account.live.com/proofs/AppPassword',
		steps: 'Turn on two-step verification, create an app password and paste it here.',
	},
	'live.com': {
		provider: 'Outlook',
		url: 'https://account.live.com/proofs/AppPassword',
		steps: 'Turn on two-step verification, create an app password and paste it here.',
	},
	// Apple iCloud Mail.
	'icloud.com': {
		provider: 'iCloud',
		url: 'https://appleid.apple.com/account/manage',
		steps: 'Under Sign-In & Security → App-Specific Passwords, generate one and paste it here.',
	},
	'me.com': {
		provider: 'iCloud',
		url: 'https://appleid.apple.com/account/manage',
		steps: 'Under Sign-In & Security → App-Specific Passwords, generate one and paste it here.',
	},
	'mac.com': {
		provider: 'iCloud',
		url: 'https://appleid.apple.com/account/manage',
		steps: 'Under Sign-In & Security → App-Specific Passwords, generate one and paste it here.',
	},
	// Yahoo Mail.
	'yahoo.com': {
		provider: 'Yahoo',
		url: 'https://login.yahoo.com/account/security/app-passwords',
		steps: 'Generate an app password under Account Security and paste it here.',
	},
	'ymail.com': {
		provider: 'Yahoo',
		url: 'https://login.yahoo.com/account/security/app-passwords',
		steps: 'Generate an app password under Account Security and paste it here.',
	},
	'yahoo.co.uk': {
		provider: 'Yahoo',
		url: 'https://login.yahoo.com/account/security/app-passwords',
		steps: 'Generate an app password under Account Security and paste it here.',
	},
};

/**
 * Return app-password guidance for the email's domain, or `null` when the domain
 * is unknown / the address is malformed / the provider does not use app
 * passwords. Pure and synchronous — no network.
 */
export function appPasswordHelpForEmail(email: string): AppPasswordHelp | null {
	const domain = domainOfEmail(email);
	if (!domain) return null;
	return APP_PASSWORD_PROVIDERS[domain] ?? null;
}

/**
 * A mail provider the unified import wizard offers as a one-click starting
 * point. A provider with a `preset` fills the IMAP/SMTP servers for the user;
 * the generic `imap` provider has none, so the user types the server settings
 * themselves. `appPassword` carries the same actionable guidance surfaced by
 * {@link appPasswordHelpForEmail}, keyed by provider rather than by domain so a
 * company Gmail (you@acme.com) still gets Gmail's app-password steps.
 */
export type MailProviderId = 'gmail' | 'outlook' | 'fastmail' | 'icloud' | 'yahoo' | 'imap';

export type MailProvider = {
	id: MailProviderId;
	/** Human name shown on the picker card. */
	name: string;
	/** Lucide icon name for the picker card. */
	icon: string;
	/** One concise line under the name (the server, or a plain hint). */
	hint: string;
	/** Server preset, or `null` for the generic IMAP provider (manual entry). */
	preset: MailPreset | null;
	/** App-password guidance, or `null` when the provider needs no app password. */
	appPassword: AppPasswordHelp | null;
	/** Whether the user must fill in the IMAP/SMTP servers by hand. */
	manualServer: boolean;
};

const YAHOO_PRESET: MailPreset = {
	imapHost: 'imap.mail.yahoo.com',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: 'smtp.mail.yahoo.com',
	smtpPort: 465,
	isSmtpSecure: true,
};

/**
 * The curated provider list the import wizard shows, in the order they appear.
 * Presets reuse the domain table above so the picker and autodiscover never
 * disagree; the generic IMAP entry is always last.
 */
export const MAIL_PROVIDERS: readonly MailProvider[] = [
	{
		id: 'gmail',
		name: 'Gmail',
		icon: 'lucide:mail',
		hint: 'Gmail or Google Workspace',
		preset: DOMAIN_PRESETS['gmail.com'] ?? null,
		appPassword: APP_PASSWORD_PROVIDERS['gmail.com'] ?? null,
		manualServer: false,
	},
	{
		id: 'outlook',
		name: 'Outlook',
		icon: 'lucide:mail',
		hint: 'Outlook.com, Hotmail or Microsoft 365',
		preset: DOMAIN_PRESETS['outlook.com'] ?? null,
		appPassword: APP_PASSWORD_PROVIDERS['outlook.com'] ?? null,
		manualServer: false,
	},
	{
		id: 'fastmail',
		name: 'Fastmail',
		icon: 'lucide:mail',
		hint: 'imap.fastmail.com',
		preset: DOMAIN_PRESETS['fastmail.com'] ?? null,
		appPassword: {
			provider: 'Fastmail',
			url: 'https://app.fastmail.com/settings/security/apppasswords',
			steps:
				'Create an app password under Settings → Privacy & Security → App Passwords and paste it here.',
		},
		manualServer: false,
	},
	{
		id: 'icloud',
		name: 'iCloud Mail',
		icon: 'lucide:mail',
		hint: 'icloud.com, me.com or mac.com',
		preset: DOMAIN_PRESETS['icloud.com'] ?? null,
		appPassword: APP_PASSWORD_PROVIDERS['icloud.com'] ?? null,
		manualServer: false,
	},
	{
		id: 'yahoo',
		name: 'Yahoo Mail',
		icon: 'lucide:mail',
		hint: 'imap.mail.yahoo.com',
		preset: YAHOO_PRESET,
		appPassword: APP_PASSWORD_PROVIDERS['yahoo.com'] ?? null,
		manualServer: false,
	},
	{
		id: 'imap',
		name: 'Any IMAP mailbox',
		icon: 'lucide:server',
		hint: 'Your own server, or any other provider',
		preset: null,
		appPassword: null,
		manualServer: true,
	},
];

/** Look up a provider by id, or `undefined` for an unknown id. */
export function providerById(id: string): MailProvider | undefined {
	return MAIL_PROVIDERS.find((p) => p.id === id);
}

/** The IMAP/SMTP preset for a provider id, or `null` (generic IMAP / unknown). */
export function providerPreset(id: string): MailPreset | null {
	return providerById(id)?.preset ?? null;
}

/** Autoconfig `socketType` values that mean "implicit TLS". */
function isSecureSocket(socketType: string | null): boolean {
	return socketType?.toUpperCase() === 'SSL';
}

/**
 * Parse the `<incomingServer type="imap">` / `<outgoingServer type="smtp">`
 * blocks of a Thunderbird autoconfig XML document into a `MailPreset`. Returns
 * `null` when either server block or a required field is missing.
 */
function parseAutoconfigXml(xml: string): MailPreset | null {
	try {
		const doc = new DOMParser().parseFromString(xml, 'application/xml');
		if (doc.querySelector('parsererror')) return null;

		const incoming = Array.from(doc.querySelectorAll('incomingServer')).find(
			(el) => el.getAttribute('type')?.toLowerCase() === 'imap'
		);
		const outgoing = doc.querySelector('outgoingServer[type="smtp"]');
		if (!incoming || !outgoing) return null;

		const text = (parent: Element, tag: string): string | null =>
			parent.querySelector(tag)?.textContent?.trim() ?? null;

		const imapHost = text(incoming, 'hostname');
		const imapPort = Number(text(incoming, 'port'));
		const smtpHost = text(outgoing, 'hostname');
		const smtpPort = Number(text(outgoing, 'port'));
		if (!imapHost || !smtpHost || !Number.isFinite(imapPort) || !Number.isFinite(smtpPort)) {
			return null;
		}

		return {
			imapHost,
			imapPort,
			isImapSecure: isSecureSocket(text(incoming, 'socketType')),
			smtpHost,
			smtpPort,
			isSmtpSecure: isSecureSocket(text(outgoing, 'socketType')),
		};
	} catch {
		return null;
	}
}

/** Fetch a URL and return its text body, or `null` on any error / non-2xx / timeout. */
async function fetchTextSoft(url: string, timeoutMs: number): Promise<string | null> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(url, { signal: controller.signal });
			if (!response.ok) return null;
			return await response.text();
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return null;
	}
}

/**
 * FAIL-SOFT autodiscover for domains not in the curated table. Tries the
 * Thunderbird autoconfig service, then the domain's own well-known autoconfig
 * endpoint, and parses the first valid response. Returns `null` on ANY error
 * (network, timeout, malformed XML, missing fields) — callers treat that as
 * "no suggestion, fill it in manually".
 *
 * @param email      the address whose domain to look up
 * @param timeoutMs  per-request timeout (default 3s)
 */
export async function autodiscover(email: string, timeoutMs = 3000): Promise<MailPreset | null> {
	const domain = domainOfEmail(email);
	if (!domain) return null;

	const encoded = encodeURIComponent(domain);
	const endpoints = [
		`https://autoconfig.thunderbird.net/v1.1/${encoded}`,
		`https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`,
	];

	for (const url of endpoints) {
		const xml = await fetchTextSoft(url, timeoutMs);
		if (!xml) continue;
		const preset = parseAutoconfigXml(xml);
		if (preset) return preset;
	}
	return null;
}

/**
 * Resolve a preset for an email address: the curated table first (instant),
 * falling back to fail-soft {@link autodiscover} for unknown domains. Always
 * resolves — `null` when nothing could be determined.
 */
export async function resolveMailPreset(
	email: string,
	timeoutMs = 3000
): Promise<MailPreset | null> {
	return presetForEmail(email) ?? (await autodiscover(email, timeoutMs));
}
