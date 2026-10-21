/**
 * The secret-free execution identity of a resolved language model:
 * `<provider kind>|<model>|<endpoint>`.
 * Two resolutions answer alike only when this is equal, so a stored decision
 * answer stamped with another is not reused: another provider, model, host
 * or base URL asks again.
 *
 * The endpoint is EXACT ({@link exactEndpointIdentity}): the language SDK
 * clients receive the stored base URL as it is, unnormalized, so `/a/v1` and
 * `/a//v1` are different endpoints and must not share an identity. The
 * embedding plane's `endpointIdentity` (`lib/embeddingSpace.ts`) canonicalizes
 * on purpose, because its client dispatches the canonical URL; it is left as
 * it is.
 *
 * Pure and runtime-neutral.
 */

import { sha256Hex } from '../aiRouting/routeDigest';

/** `scheme://user:pass@` → `scheme://`: the userinfo, the only credential-shaped part of a URL's authority. */
const USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i;

/**
 * The identity of the exact base URL string a client is given: its origin,
 * for a reader, and a SHA-256 prefix of the string itself with the userinfo
 * removed and nothing else changed (path, repeated slashes, query and case
 * kept). A query may still carry a key, so only the digest is kept.
 */
export function exactEndpointIdentity(baseUrl: string): string {
	const dispatched = baseUrl.replace(USERINFO, '$1');
	let origin: string;
	try {
		origin = new URL(dispatched).origin.toLowerCase();
	} catch {
		origin = 'invalid';
	}
	return `${origin}/~${sha256Hex(dispatched).slice(0, 32)}`;
}

/**
 * The identity of a resolved language model; `baseUrl` is the very value the
 * resolver hands the SDK client (`lib/llmProvider.ts`), or absent.
 */
export function languageModelIdentity(
	kind: string,
	modelId: string,
	baseUrl: string | undefined
): string {
	return [kind, modelId, baseUrl ? exactEndpointIdentity(baseUrl) : ''].join('|');
}
