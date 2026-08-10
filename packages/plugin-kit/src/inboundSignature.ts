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
 * WHO VERIFIES. The host does, always. A plugin declares the shape — for the
 * parameterized HMAC: which header carries the signature, which HMAC family
 * produced it, how it is encoded, and which `PLUGIN_`-scoped environment
 * variable holds the shared secret; for a named scheme like Svix: only the
 * secret variable and the freshness window, because everything else is the
 * scheme's — and the host recomputes and compares in constant time. Plugin code
 * is never asked whether a request is authentic, so a plugin can neither weaken
 * nor bypass the check, and the secret never crosses into plugin code.
 *
 * The webhook-side vocabulary is {@link PluginWebhookSignatureContract}, whose
 * arms are documented below together with the two host schemes this tier
 * deliberately does not offer.
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
 *
 * THE RULE IS STATED ONCE, HERE, FOR EVERY DECLARATION WHOSE VALUE THE HOST
 * READS. A settings `secret` (`./settingsSchemaManifest`) and a send transport's
 * configuration variables (`./sendTransport`) pass the same fence through the
 * same predicate — the second by COMPOSING onto it, so a future tightening of the
 * namespace lands on all three at once rather than on whichever copy the author
 * happened to be reading.
 */
const SECRET_ENV_VAR = /^PLUGIN_[A-Z0-9][A-Z0-9_]*$/;

/**
 * Whether a value names a plugin-scoped variable a manifest may point the host
 * at — the shared `PLUGIN_` namespace fence described above.
 *
 * It is deliberately NOT a per-plugin fence, and cannot be: the shipped manifests
 * name their variables after the vendor rather than after the plugin id
 * (`slack-approvals` declares `PLUGIN_SLACK_BOT_TOKEN`), so one plugin can name
 * another's variable. Defense in depth against the HOST's own credentials, not
 * isolation between bundled plugins — a bundled module runs in the same Node
 * action and could read `process.env` itself.
 */
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

/**
 * An inbound contract that DOES gate an endpoint, so replay defense is required.
 *
 * `scheme` is OPTIONAL and absent means this one: it is the shape every webhook
 * manifest was written against before the vocabulary widened, so a contract that
 * spells no scheme is this contract and composes exactly as it did. Spelling it
 * is allowed for symmetry with {@link PluginSvixSignatureContract}, and the word
 * is the host's own (`hmac-timestamp-body` in
 * `apps/api/convex/webhooks/providerVerifierRegistry.ts`) rather than a second
 * name for the same scheme.
 */
export interface PluginReplayBoundSignatureContract extends PluginInboundSignatureContract {
	readonly scheme?: 'hmac-timestamp-body';
	readonly replay: PluginInboundReplayContract;
}

/**
 * The Svix scheme, host-verified — the second word this tier may declare.
 *
 * WHY IT EXISTS. Svix is what a large share of real ESPs sign their webhooks
 * with (Resend, whose core adapter is verified by the very same host helper, is
 * one). A bundled plugin wrapping such an ESP could previously declare only the
 * HMAC-over-`<timestamp>.<rawBody>` contract above, so the one thing the operator
 * has to do — paste `/webhooks/plugin/<id>` into the provider's console — could
 * not be made to work at all: the console signs Svix-style and the host was
 * recomputing a different string. A tier whose promise is "ships without host
 * edits" cannot be one signature scheme away from needing a host edit.
 *
 * NOTHING ABOUT THE VERIFICATION IS DECLARABLE, and that is the point. The
 * headers (`svix-id`, `svix-timestamp`, `svix-signature`), the HMAC family
 * (SHA-256), the encoding (base64), the signed string (`<id>.<timestamp>.<body>`)
 * and the secret's `whsec_`-prefixed base64 form are all the SCHEME's, fixed by
 * Svix and implemented once in the host. A manifest that could spell them could
 * only ever disagree with the scheme it named. So this arm carries exactly the
 * two facts that are genuinely the deployment's: which `PLUGIN_`-scoped variable
 * holds the endpoint secret, and how far the signed timestamp may sit from now.
 *
 * REPLAY DEFENSE IS INTRINSIC HERE rather than declared: the timestamp is inside
 * the signed string by construction, so there is no `replay` record to write —
 * `toleranceSeconds` is the whole of what the shape above's `replay` adds, and it
 * is bounded by {@link PLUGIN_INBOUND_REPLAY_MAX_TOLERANCE_SECONDS} and clamped
 * by the host at request time exactly as that one is. The host's delivery
 * de-duplication is the other half for both arms alike: a claim is about the
 * batch, not about which scheme proved it.
 *
 * WHAT THIS TIER DELIBERATELY STILL CANNOT DECLARE, and why the vocabulary stops
 * at two words:
 *
 *  - `aws-sns` is HOST INFRASTRUCTURE, not a signature a manifest picks. It is
 *    verified against a certificate fetched from an Amazon URL, cached by the
 *    host, and constrained to a subscription the deployment owns
 *    (`topicArnEnvVar`, which is not a `PLUGIN_` secret at all). A plugin
 *    declaring it would be pointing the host's certificate machinery at a topic
 *    the plugin does not own.
 *  - `mandrill-form` is a LEGACY VENDOR scheme: an HMAC over the request URL and
 *    the sorted form params, where the signed URL is the deployment's own public
 *    address — which no build artifact knows, so the host derives candidates at
 *    request time. It exists to keep one incumbent working, not as a shape a new
 *    integration should be written to.
 */
export interface PluginSvixSignatureContract {
	readonly scheme: 'svix';
	/** Environment variable holding the endpoint's Svix signing secret. */
	readonly secretEnvVar: string;
	/**
	 * Accepted absolute clock difference, in seconds. Bounded by
	 * {@link PLUGIN_INBOUND_REPLAY_MAX_TOLERANCE_SECONDS} at manifest time and
	 * clamped again by the host at request time — the same ceiling, and for the
	 * same reason, as the replay-bound arm's `replay.toleranceSeconds`.
	 */
	readonly toleranceSeconds: number;
}

/**
 * What a send transport's feedback webhook may declare: one of the two
 * HOST-VERIFIED schemes above, and nothing else.
 *
 * A UNION OF SCHEMES, NOT A DELEGATION. Widening this list does not move one
 * inch of the decision: the plugin still names a shape, the host still holds the
 * secret, recomputes and compares, and plugin code is still never asked whether
 * bytes are authentic. Every arm here is verified by host code the CORE providers
 * are verified by — the replay-bound one by the same parameterized HMAC the
 * `hmac-timestamp-body` bundles use, the Svix one by the same `verifySvixHeaders`
 * the Resend path uses — so a plugin cannot reach a verifier the host does not
 * already own and trust.
 */
export type PluginWebhookSignatureContract =
	| PluginReplayBoundSignatureContract
	| PluginSvixSignatureContract;

/**
 * Which arm a contract is, as ONE predicate rather than a `scheme` comparison
 * repeated in the validator, the renderer, the host's load-time guard and the
 * route. The discriminant is spelled once so those four cannot drift.
 */
export function isPluginSvixSignatureContract(
	contract: PluginWebhookSignatureContract
): contract is PluginSvixSignatureContract {
	return contract.scheme === 'svix';
}
