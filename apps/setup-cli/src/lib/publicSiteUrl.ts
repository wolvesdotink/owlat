/**
 * Whether the links in system mail can be opened anywhere but on this server.
 *
 * Verification, password-reset and invitation mail link to `SITE_URL`. The
 * terminal wizard asks for no public URL on purpose: a public `SITE_URL` only
 * works together with the reverse proxy and TLS that serve it (the config
 * file's `network` section sets up both), and once set it is the only origin
 * sign-in trusts, so a public URL that nothing serves yet would also break
 * sign-in on localhost. A terminal install therefore stays on localhost, and
 * the quickstart summary and `owlat doctor` say so as soon as the box sends
 * mail as a public domain.
 */

import type { EnvMap } from './env';

const PRODUCTION_GUIDE = 'https://docs.owlat.app/developer/self-hosting-production#reverse-proxy';

/** The URL system mail links to, with the runtime's own fallback. */
export function systemMailSiteUrl(env: EnvMap): string {
	return env['SITE_URL']?.trim() || 'http://localhost:3000';
}

function isLocalHostname(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	return (
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		host === '::1' ||
		host === '0.0.0.0' ||
		host.startsWith('127.')
	);
}

/** True when `siteUrl` only resolves on this machine (or does not parse). */
export function isLocalSiteUrl(siteUrl: string): boolean {
	try {
		return isLocalHostname(new URL(siteUrl).hostname);
	} catch {
		return true;
	}
}

/**
 * The public domain this box sends mail as: the system From domain (or the
 * domain of the From address), else the MTA's EHLO hostname. Undefined for a
 * local install, which sends to nobody elsewhere and needs no public URL.
 */
export function publicMailIdentity(env: EnvMap): string | undefined {
	const fromEmail = env['DEFAULT_FROM_EMAIL']?.trim() ?? '';
	const candidates = [
		env['DEFAULT_FROM_DOMAIN'],
		fromEmail.slice(fromEmail.lastIndexOf('@') + 1),
		env['EHLO_HOSTNAME'],
	];
	for (const candidate of candidates) {
		const name = candidate?.trim();
		if (name && name.includes('.') && !isLocalHostname(name)) return name;
	}
	return undefined;
}

/** The fix, as commands the operator can paste. */
export const PUBLIC_SITE_URL_STEPS = [
	`Serve Owlat on a public HTTPS address (${PRODUCTION_GUIDE}), then run:`,
	'  owlat env SITE_URL https://owlat.example.com',
	'  owlat env NUXT_PUBLIC_SITE_URL https://owlat.example.com',
	'  owlat apply',
];

/**
 * The quickstart summary's lines about a localhost `SITE_URL` on a box that
 * sends mail as a public domain; nothing in any other case.
 */
export function localSiteUrlNotice(env: EnvMap): string[] {
	const siteUrl = systemMailSiteUrl(env);
	if (!publicMailIdentity(env) || !isLocalSiteUrl(siteUrl)) return [];
	return [
		`Links in sign-up verification, password-reset and invitation mail point at ${siteUrl}, which only this server can open.`,
		...PUBLIC_SITE_URL_STEPS,
	];
}
