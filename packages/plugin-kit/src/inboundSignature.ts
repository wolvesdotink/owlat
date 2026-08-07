/**
 * The declared contract by which the HOST verifies a request that arrives from
 * outside Owlat on a plugin's behalf.
 *
 * It lives in its own leaf module because two contributions now declare one:
 * import providers (their vendor callbacks) and send transports (their feedback
 * webhook, the seams plan's D6/P2.2). The types were originally written for the
 * first and were read out of `./importProvider`; they are re-exported from there
 * so existing imports keep resolving.
 *
 * WHO VERIFIES. The host does, always. A plugin declares the shape — which
 * header carries the signature, which HMAC family produced it, how it is
 * encoded, and which `PLUGIN_`-scoped environment variable holds the shared
 * secret — and the host recomputes and compares in constant time. Plugin code is
 * never asked whether a request is authentic, so a plugin can neither weaken nor
 * bypass the check, and the secret never crosses into plugin code.
 */

/** HMAC families the host can recompute and compare in constant time. */
export type PluginInboundSignatureAlgorithm = 'hmac-sha256' | 'hmac-sha1';
export type PluginInboundSignatureEncoding = 'hex' | 'base64';

/** Widest accepted freshness window for a replay-bound contract, in seconds. */
export const PLUGIN_INBOUND_REPLAY_MAX_TOLERANCE_SECONDS = 900;

/**
 * Replay provisions: what turns an origin proof into a delivery that can only
 * happen once.
 *
 * An HMAC over the body alone proves origin and nothing else — the same captured
 * bytes verify forever. Binding a caller-supplied timestamp INTO the signed
 * string, and refusing a timestamp further from now than `toleranceSeconds`,
 * bounds how long a captured request stays valid; the host's own delivery
 * de-duplication then removes the remaining window. Both halves are needed:
 * freshness alone still allows a replay within the tolerance, and de-duplication
 * alone would have to remember every delivery forever.
 *
 * The signed string is `<timestamp>.<rawBody>`, so rewriting the header
 * invalidates the signature.
 */
export interface PluginInboundReplayContract {
	/** Lower-cased HTTP header carrying the signed UNIX timestamp, in seconds. */
	readonly timestampHeader: string;
	/**
	 * Accepted absolute clock difference, in seconds. Bounded by
	 * {@link PLUGIN_INBOUND_REPLAY_MAX_TOLERANCE_SECONDS} at manifest time and
	 * clamped again by the host at request time.
	 */
	readonly toleranceSeconds: number;
}

/**
 * Required contract describing how the host verifies the signature on any
 * inbound request a plugin contribution receives — provider webhook callbacks,
 * paged-fetch continuation callbacks, or event notifications.
 *
 * The host reads the shared secret from `secretEnvVar`, recomputes the
 * `algorithm` HMAC over the signing string, encodes it as `encoding`, and
 * compares it against the value carried in the `header` using a constant-time
 * comparison. Verification fails closed when the secret is unset or the header
 * is missing, malformed, or does not match — a plugin can never opt out of it.
 *
 * Scope of the guarantee WITHOUT `replay`: origin only. The signed payload is
 * the raw body alone, with no timestamp, tolerance, or nonce, so a captured
 * request verifies forever. That is why every contract that gates a live HTTP
 * surface must declare `replay`: the send-transport webhook validator requires
 * it, and the import-provider contract (which gates no endpoint today) does not
 * accept it yet.
 */
export interface PluginInboundSignatureContract {
	/** Lower-cased HTTP header carrying the caller-supplied signature. */
	readonly header: string;
	readonly algorithm: PluginInboundSignatureAlgorithm;
	readonly encoding: PluginInboundSignatureEncoding;
	/** Environment variable holding the shared signing secret. */
	readonly secretEnvVar: string;
	/** Present exactly where an endpoint accepts the traffic (see above). */
	readonly replay?: PluginInboundReplayContract;
}

/** An inbound contract that DOES gate an endpoint, so replay defense is required. */
export interface PluginReplayBoundSignatureContract extends PluginInboundSignatureContract {
	readonly replay: PluginInboundReplayContract;
}
