/**
 * The public HTTPS address of an install: the three hostnames the bundled Caddy
 * edge (`tls` compose profile) serves, the `.env` keys that point the web app,
 * Convex and system mail at them, and the Caddyfile that serves them.
 *
 * The config file's `network` section and the terminal wizard's public-address
 * step both go through here, so the two paths write the same variables and the
 * same proxy configuration for the same hostnames.
 *
 * A public `SITE_URL` becomes the only origin sign-in trusts, so it is only ever
 * written together with the Caddy edge that serves it. That pairing is also how
 * an install is recognised as running behind the bundled edge: `tls` in
 * `COMPOSE_PROFILES` and a public `SITE_URL`. A public `SITE_URL` without the
 * `tls` profile is an operator's own proxy, which the installer leaves alone.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseComposeProfileList } from '@owlat/shared/composeOverride';
import type { SetupConfig } from '@owlat/shared/setupConfigTypes';
import { buildCaddyfile } from './caddyfile';
import type { EnvMap } from './env';
import { isLocalSiteUrl } from './publicSiteUrl';
import { applyBundledProxyDefaults } from './setupEnvDefaults';

export type PublicNetwork = NonNullable<SetupConfig['network']>;

/** The compose profile that runs the Caddy edge. */
const TLS_PROFILE = 'tls';

/**
 * The subdomains one domain expands into: the desktop wizard's default labels
 * (`apps/web/app/lib/desktop/provisioning.ts`) and `Caddyfile.example`'s names.
 */
const LABELS = { site: 'owlat', convex: 'api', convexSite: 'rest.api' } as const;

const LOCAL_URLS: EnvMap = {
	SITE_URL: 'http://localhost:3000',
	NUXT_PUBLIC_SITE_URL: 'http://localhost:3000',
	NUXT_PUBLIC_CONVEX_URL: 'http://localhost:3210',
	NUXT_PUBLIC_CONVEX_SITE_URL: 'http://localhost:3211',
	CONVEX_SITE_URL: 'http://localhost:3211',
};

/** A DNS name with at least two labels, as typed by an operator (no scheme, no port). */
export function isPublicDomainName(value: string): boolean {
	const name = normalizeDomain(value);
	return (
		/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name) &&
		!isLocalSiteUrl(`https://${name}`)
	);
}

function normalizeDomain(value: string): string {
	return value.trim().toLowerCase().replace(/\.$/, '');
}

/** The three public URLs for one domain: `owlat.`, `api.` and `rest.api.` under it. */
export function networkFromDomain(domain: string): PublicNetwork {
	const d = normalizeDomain(domain);
	return {
		siteUrl: `https://${LABELS.site}.${d}`,
		convexUrl: `https://${LABELS.convex}.${d}`,
		convexSiteUrl: `https://${LABELS.convexSite}.${d}`,
	};
}

/** The hostnames of a network, web app first. */
export function networkHosts(network: PublicNetwork): string[] {
	return [network.siteUrl, network.convexUrl, network.convexSiteUrl].map(
		(url) => new URL(url).hostname
	);
}

/**
 * The domain a network was derived from, for pre-filling the wizard; the web
 * host itself when the names do not follow the `owlat.` convention.
 */
export function domainOfNetwork(network: PublicNetwork): string {
	const host = new URL(network.siteUrl).hostname;
	return host.startsWith(`${LABELS.site}.`) ? host.slice(LABELS.site.length + 1) : host;
}

/**
 * The `.env` keys for a public network. Set as a patch so `applySetupDefaults`
 * (which only fills absent keys) cannot put them back to localhost.
 * CONVEX_SITE_URL is the function runtime's own site URL; the NUXT_PUBLIC_*
 * values are what the web app, the Convex container's public origins and the
 * desktop client (via /api/instance-info) consume.
 */
export function publicNetworkEnv(network: PublicNetwork): EnvMap {
	return {
		SITE_URL: network.siteUrl,
		NUXT_PUBLIC_SITE_URL: network.siteUrl,
		NUXT_PUBLIC_CONVEX_URL: network.convexUrl,
		NUXT_PUBLIC_CONVEX_SITE_URL: network.convexSiteUrl,
		CONVEX_SITE_URL: network.convexSiteUrl,
	};
}

function profilesOf(env: EnvMap): string[] {
	return parseComposeProfileList(env['COMPOSE_PROFILES'] ?? '');
}

/** The network the bundled Caddy edge serves for this `.env`, if it runs one. */
export function bundledEdgeNetwork(env: EnvMap): PublicNetwork | undefined {
	const siteUrl = env['SITE_URL']?.trim();
	const convexUrl = env['NUXT_PUBLIC_CONVEX_URL']?.trim();
	const convexSiteUrl = env['NUXT_PUBLIC_CONVEX_SITE_URL']?.trim();
	if (!profilesOf(env).includes(TLS_PROFILE)) return undefined;
	if (!siteUrl || !convexUrl || !convexSiteUrl || isLocalSiteUrl(siteUrl)) return undefined;
	return { siteUrl, convexUrl, convexSiteUrl };
}

/**
 * Point an env at a public network behind the bundled edge: the URL keys, the
 * `tls` profile and the client-address trust that only holds behind it.
 */
export function withPublicNetwork(env: EnvMap, network: PublicNetwork): EnvMap {
	const next: EnvMap = { ...env, ...publicNetworkEnv(network) };
	next['COMPOSE_PROFILES'] = [...new Set([...profilesOf(env), TLS_PROFILE])].join(',');
	applyBundledProxyDefaults(next);
	return next;
}

/**
 * Undo {@link withPublicNetwork}: localhost URLs, no `tls` profile, and no
 * forwarded-address trust the edge had set (an operator's other value stays).
 */
export function withLocalNetwork(env: EnvMap): EnvMap {
	const next: EnvMap = { ...env, ...LOCAL_URLS };
	next['COMPOSE_PROFILES'] = profilesOf(env)
		.filter((profile) => profile !== TLS_PROFILE)
		.join(',');
	if (next['RATE_LIMIT_TRUSTED_PROXY'] === 'xforwarded') delete next['RATE_LIMIT_TRUSTED_PROXY'];
	return next;
}

/** The Caddyfile that serves a network; `email` is the Let's Encrypt account contact. */
export function caddyfileForNetwork(network: PublicNetwork, email: string): string {
	const [webHost, convexHost, convexSiteHost] = networkHosts(network) as [string, string, string];
	return buildCaddyfile({ webHost, convexHost, convexSiteHost, email });
}

/** Write the install's Caddyfile for a network. */
export async function writeCaddyfile(
	owlatDir: string,
	network: PublicNetwork,
	email: string
): Promise<void> {
	await writeFile(join(owlatDir, 'Caddyfile'), caddyfileForNetwork(network, email), 'utf-8');
}
