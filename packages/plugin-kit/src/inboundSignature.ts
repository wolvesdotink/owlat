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

/** Longest accepted header or environment-variable name in a contract. */
export const PLUGIN_INBOUND_MAX_NAME_LENGTH = 128;

/**
 * The signing secret must live in a plugin-scoped `PLUGIN_`-prefixed variable.
 *
 * THE ONLY BARRIER between a manifest and the host's whole environment: the host
 * reads the named key verbatim, so a contract naming `CONVEX_DEPLOY_KEY` or an
 * admin token would turn its endpoint into an HMAC oracle over that secret,
 * against attacker-chosen bodies. Declared here, next to the contract type, and
 * shared by everyone who has to uphold it: the manifest validator refuses such a
 * contract at authoring time, and the host re-asserts it when it loads a
 * generated artifact — because an artifact is exactly the place where the
 * validator's guarantee may no longer hold (a hand edit, a bad merge, a partial
 * regeneration, or a manifest validated by an older kit).
 */
const SECRET_ENV_VAR = /^PLUGIN_[A-Z0-9][A-Z0-9_]*$/;

/** Whether a value names a signing secret this contract is allowed to read. */
export function isPluginSecretEnvVar(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length <= PLUGIN_INBOUND_MAX_NAME_LENGTH &&
		SECRET_ENV_VAR.test(value)
	);
}

/**
 * Whether a freshness window is a usable one — an integer from 1 second to
 * {@link PLUGIN_INBOUND_REPLAY_MAX_TOLERANCE_SECONDS}. Zero and negatives would
 * refuse every real delivery; anything wider stops bounding a captured request.
 */
export function isBoundedReplayToleranceSeconds(value: unknown): value is number {
	return (
		Number.isSafeInteger(value) &&
		(value as number) >= 1 &&
		(value as number) <= PLUGIN_INBOUND_REPLAY_MAX_TOLERANCE_SECONDS
	);
}

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
