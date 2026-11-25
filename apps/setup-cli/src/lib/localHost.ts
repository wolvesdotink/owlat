/**
 * Where the wizard reaches the just-started backend's published ports.
 *
 * The installer runs ON the box, so it talks to the backend over the host's
 * published ports (3210 cloud / 3211 site unless `.env` moves them). HOW it
 * addresses those ports depends on the container network:
 *
 *   - Linux host networking (the blessed VPS path): the wizard container shares
 *     the host loopback, so `localhost` reaches the published ports directly.
 *   - Docker Desktop (macOS/Windows): containers run inside a Linux VM, so
 *     `localhost` points at that VM, not the host. scripts/owlat then runs the
 *     wizard on the bridge network with
 *     `--add-host=host.docker.internal:host-gateway` and sets
 *     OWLAT_LOCAL_HOST=host.docker.internal so we reach the published host
 *     ports via that alias instead.
 *
 * Defaults to `localhost` so the blessed Linux behaviour is unchanged.
 */
export function resolveLocalHost(env: NodeJS.ProcessEnv = process.env): string {
	return env['OWLAT_LOCAL_HOST'] ?? 'localhost';
}

/**
 * The host ports docker-compose.yml publishes as `${NAME:-default}`, with
 * those defaults. An operator moves one by setting it in the install's `.env`,
 * which is where compose reads it; keep the defaults equal to the compose file.
 */
const PUBLISHED_PORT_DEFAULTS = {
	CONVEX_PORT: '3210',
	CONVEX_SITE_PORT: '3211',
	WEB_PORT: '3000',
} as const;

/** The host port compose publishes for `name`: its `.env` value, else the default (compose's `:-` also treats empty as unset). */
export function publishedPort(
	env: Record<string, string | undefined>,
	name: keyof typeof PUBLISHED_PORT_DEFAULTS
): string {
	return env[name]?.trim() || PUBLISHED_PORT_DEFAULTS[name];
}

interface LocalUrls {
	localCloud: string;
	localSite: string;
}

/**
 * Derive the on-box cloud and site URLs the wizard probes and POSTs to.
 *
 * For a domain install (`network` present) the NUXT_PUBLIC_* / CONVEX_* values
 * hold PUBLIC URLs (for clients + the function runtime) that aren't reachable
 * on-box until DNS + TLS are live — so we ignore them and address the published
 * ports on the resolved local host directly. For a local install we use the
 * `.env` values when set, falling back to the resolved local host otherwise
 * (which is itself just the published ports).
 */
export function resolveLocalUrls(opts: {
	/** True for a domain install (config.network present), false/undefined for local. */
	network?: boolean;
	/** Parsed `.env` values. */
	env: Record<string, string | undefined>;
	/** Override host; defaults to OWLAT_LOCAL_HOST ?? 'localhost'. */
	localHost?: string;
}): LocalUrls {
	const localHost = opts.localHost ?? resolveLocalHost();
	const publishedCloud = `http://${localHost}:${publishedPort(opts.env, 'CONVEX_PORT')}`;
	const publishedSite = `http://${localHost}:${publishedPort(opts.env, 'CONVEX_SITE_PORT')}`;
	const localCloud = opts.network
		? publishedCloud
		: opts.env['NUXT_PUBLIC_CONVEX_URL'] || publishedCloud;
	const localSite = opts.network
		? publishedSite
		: opts.env['CONVEX_SITE_URL'] || opts.env['NUXT_PUBLIC_CONVEX_SITE_URL'] || publishedSite;
	return { localCloud, localSite };
}
