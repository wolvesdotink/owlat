/**
 * Whether a model endpoint runs on the operator's own hardware (ADR-0073). A
 * local request costs nothing, so its ledger row is priced at zero; anything
 * else is priced, and counts against the ceiling. ONE rule for the language,
 * embedding and decision planes, so no plane can call a paid service free.
 *
 * LOCAL:
 *   - the `local` provider kinds (the bundled embedding sidecar, the local
 *     decision engine), which exist only for self-hosted engines;
 *   - an OpenAI or OpenAI-compatible endpoint whose host is loopback (`localhost`,
 *     127.0.0.0/8, ::1), a private address (RFC 1918, link-local, IPv6 ULA
 *     and link-local), a `.local` / `.internal` / `.localhost` name, or a
 *     single-label hostname (a Docker or compose service such as `ollama`).
 * HOSTED: everything else, any public hostname included (openrouter.ai, a
 * vendor's own API).
 * FAILS CLOSED: an endpoint that cannot be parsed, or a kind not named here,
 * is hosted. Unknown locality never means free.
 *
 * Pure and runtime-neutral.
 */

export type EndpointLocality = 'local' | 'hosted';

/** Provider kinds that only ever name a self-hosted engine. */
const LOCAL_KINDS: ReadonlySet<string> = new Set(['local']);

/**
 * Provider kinds whose locality depends on where their base URL points. `openai`
 * is here because the env plane speaks the OpenAI wire to whatever `LLM_BASE_URL`
 * names (an env Ollama included); its native API, with no base URL, stays hosted.
 */
const URL_DECIDED_KINDS: ReadonlySet<string> = new Set(['openaiCompatible', 'openai']);

function isPrivateIpv4(host: string): boolean {
	const parts = host.split('.');
	if (parts.length !== 4) return false;
	const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
	if (octets.some((octet) => !Number.isInteger(octet) || octet > 255)) return false;
	const [a, b] = octets as [number, number, number, number];
	return (
		a === 127 ||
		a === 10 ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 169 && b === 254)
	);
}

function isPrivateIpv6(host: string): boolean {
	const address = host.toLowerCase();
	if (address === '::1') return true;
	// fc00::/7 (unique local) and fe80::/10 (link-local).
	return /^f[cd][0-9a-f]{0,2}:/.test(address) || /^fe[89ab][0-9a-f]?:/.test(address);
}

/** True when `hostname` (from a parsed URL) names a machine on the operator's own network. */
export function isLocalHostname(hostname: string): boolean {
	const host = hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, '')
		.replace(/\.$/, '');
	if (host === '') return false;
	if (host.includes(':')) return isPrivateIpv6(host);
	if (/^[\d.]+$/.test(host)) return isPrivateIpv4(host);
	if (host === 'localhost' || host.endsWith('.localhost')) return true;
	if (host.endsWith('.local') || host.endsWith('.internal')) return true;
	// A single-label name resolves only inside a private network (a compose service).
	return !host.includes('.');
}

/** Whether an endpoint of provider `kind` at `baseUrl` is local or hosted. */
export function resolveEndpointLocality(
	kind: string,
	baseUrl: string | undefined
): EndpointLocality {
	if (LOCAL_KINDS.has(kind)) return 'local';
	if (!URL_DECIDED_KINDS.has(kind) || baseUrl === undefined) return 'hosted';
	try {
		return isLocalHostname(new URL(baseUrl).hostname) ? 'local' : 'hosted';
	} catch {
		return 'hosted';
	}
}

/**
 * True when a resolved endpoint is local: the configured base URL, else the
 * adapter's default one (an unset OpenAI-compatible URL means the bundled
 * `localhost` default).
 */
export function isLocalEndpoint(
	kind: string,
	baseUrl: string | undefined,
	adapter: { readonly defaultBaseUrl?: string }
): boolean {
	return resolveEndpointLocality(kind, baseUrl ?? adapter.defaultBaseUrl) === 'local';
}
