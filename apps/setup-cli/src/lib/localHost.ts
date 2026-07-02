/**
 * Where the wizard reaches the just-started backend's published ports.
 *
 * The installer runs ON the box, so it talks to the backend over the host's
 * published ports (3210 cloud / 3211 site). HOW it addresses those ports
 * depends on the container network:
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
	return env.OWLAT_LOCAL_HOST ?? 'localhost';
}

interface LocalUrls {
	localCloud: string;
	localSite: string;
}

/**
 * Derive the on-box cloud (3210) and site (3211) URLs the wizard probes and
 * POSTs to.
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
	const localCloud = opts.network
		? `http://${localHost}:3210`
		: opts.env['NUXT_PUBLIC_CONVEX_URL'] || `http://${localHost}:3210`;
	const localSite = opts.network
		? `http://${localHost}:3211`
		: opts.env['CONVEX_SITE_URL'] ||
			opts.env['NUXT_PUBLIC_CONVEX_SITE_URL'] ||
			`http://${localHost}:3211`;
	return { localCloud, localSite };
}
