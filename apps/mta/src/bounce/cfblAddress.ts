/**
 * RFC 9477 `CFBL-Address` — complaint feedback with no bilateral enrollment.
 *
 * Every other complaint source we can reach (Google Postmaster, Microsoft
 * SNDS/JMRP, Yahoo CFL) requires an ACCOUNT with the mailbox provider. RFC 9477
 * requires only a HEADER: the sender advertises an address, and a participating
 * mailbox provider mails an RFC 5965 ARF report there when a user hits "Report
 * Spam". Emitting the header costs nothing and depends on nobody's enrollment,
 * which is why it is the complaint signal a zero-third-party-account deployment
 * can actually have.
 *
 * ## Why the address is signed
 *
 * The header publishes an address to the whole internet and invites
 * unauthenticated parties to send us reports that move a control loop (a
 * complaint rate feeds the routing/ramp gates). An unsigned, guessable address
 * would let anyone spray forged complaints at a chosen send and push a cell's
 * share down. So the advertised address carries a truncated HMAC over the
 * message id and a coarse time window — exactly the BATV-style construction the
 * bounce VERP token already uses (`bounce/verp.ts`), for the same reason:
 *
 *   fbl+{base64url(messageId)}+{mac}@{cfblDomain}
 *   mac = base64url( HMAC-SHA256("cfbl:" || b64url(id) || ":" || window, key) )[:14]
 *
 * The `cfbl:` prefix DOMAIN-SEPARATES this MAC from the VERP MAC, so a captured
 * bounce token can never be replayed as a complaint token (or vice versa) even
 * though both are derived from the same `BOUNCE_VERP_KEY` secret. Reusing that
 * one secret is deliberate: a second key would be a second thing to configure,
 * and this feature must stay free.
 *
 * ## Why it leaks nothing
 *
 * The token encodes ONLY the opaque internal message id. No recipient address,
 * no recipient hash, no organization id, no campaign name. A passive observer
 * of the header (including the recipient's own mail client) learns nothing about
 * who else was mailed, and cannot correlate two messages to one recipient.
 *
 * ## Freshness
 *
 * Verification accepts the current window, {@link ACCEPTED_PAST_WINDOWS} past
 * windows (complaints arrive days after the send — users report spam long after
 * it lands) and ONE future window (clock skew between signer and verifier).
 * Beyond that a token is EXPIRED, which is reported as its own reason so an
 * operator can tell "stale" apart from "forged".
 *
 * Every function here is PURE apart from the optional `process.env` key lookup
 * that mirrors `verp.ts`: no clock reads that aren't injectable, no I/O, no
 * throwing. A rejection is a returned reason the caller COUNTS.
 */

import {
	MAX_FEEDBACK_TOKEN_ACCEPTANCE_SECONDS,
	SIGNED_TOKEN_FUTURE_WINDOWS,
	SIGNED_TOKEN_WINDOW_MS,
	computeSignedTokenMac,
	currentSignedTokenWindow,
	findSignedTokenWindowAge,
	resolveSignedTokenKey,
} from './signedToken.js';

/** Envelope local-part prefix for the complaint feedback address. */
export const CFBL_LOCAL_PREFIX = 'fbl';

/** RFC 9477 §4.1 `report=` parameter value: we accept RFC 5965 ARF reports. */
export const CFBL_REPORT_FORMAT = 'arf';

/**
 * Domain-separation label for the complaint MAC. The VERP bounce token signs
 * `{encodedId}:{window}` with no label, so this prefix is what makes a captured
 * bounce token unusable as a complaint token and vice versa (see
 * `bounce/signedToken.ts`, where both MACs are built).
 */
const CFBL_MAC_LABEL = 'cfbl:';

/** One future window absorbs signer/verifier clock skew around a day boundary. */
export const ACCEPTED_FUTURE_WINDOWS = SIGNED_TOKEN_FUTURE_WINDOWS;

/**
 * Past windows accepted in addition to the current one, DERIVED from the shared
 * acceptance horizon in `bounce/signedToken.ts` — that constant, not this count,
 * is where the 14-day complaint latency allowance is decided, because the dedup
 * and provenance retentions that must outlive a verifiable token read it too.
 * (13 prior days + today + one skew day = the shared 15-day span.)
 */
export const ACCEPTED_PAST_WINDOWS =
	MAX_FEEDBACK_TOKEN_ACCEPTANCE_SECONDS / (SIGNED_TOKEN_WINDOW_MS / 1000) -
	1 -
	ACCEPTED_FUTURE_WINDOWS;

/**
 * How far back verification will probe PURELY to classify a rejection as
 * `expired` rather than `bad_signature`.
 *
 * Bounded so a flood of junk reports cannot turn verification into a CPU
 * amplifier: one `parseCfblToken` call costs at most
 * `EXPIRY_PROBE_WINDOWS + ACCEPTED_FUTURE_WINDOWS + 1` HMACs (see
 * {@link MAX_HMACS_PER_TOKEN_PARSE}), and `resolveCfblAttribution` parses at
 * most three candidate tokens per report.
 */
const EXPIRY_PROBE_WINDOWS = 90;

/**
 * Worst-case HMAC count for ONE {@link parseCfblToken} call, derived from the
 * constants rather than restated in prose so it cannot drift away from them.
 */
export const MAX_HMACS_PER_TOKEN_PARSE = EXPIRY_PROBE_WINDOWS + ACCEPTED_FUTURE_WINDOWS + 1;

/** RFC 5321 §4.5.3.1.3 caps a forward-path at 256 octets; 320 is the whole path. */
const MAX_ADDRESS_LENGTH = 320;

/** Upper bound on an internal message id we are willing to encode or decode. */
const MAX_MESSAGE_ID_LENGTH = 200;

/** Why a presented CFBL address did not yield a trusted attribution. */
export type CfblRejectionReason =
	/** Not a `fbl+…@` address at all — not a CFBL report handle. */
	| 'not_cfbl'
	/** Correct shape but no MAC: an attacker's hand-built address. */
	| 'unsigned'
	/** MAC present but does not verify for any accepted window: forged/tampered. */
	| 'bad_signature'
	/** MAC verifies for a window older than the acceptance horizon. */
	| 'expired'
	/** MAC verifies but the payload does not decode to a plausible message id. */
	| 'malformed_payload'
	/** Input exceeds the bounded size we are willing to process. */
	| 'oversized'
	/** No signing key configured, so no token can be trusted. */
	| 'unverifiable';

export type CfblParseResult =
	| { readonly ok: true; readonly messageId: string }
	| { readonly ok: false; readonly reason: CfblRejectionReason };

/**
 * Resolve the signing key. Shared with VERP (`BOUNCE_VERP_KEY`) — the MAC input
 * is domain-separated, so one secret safely serves both tokens.
 */
function resolveCfblKey(explicit?: string): string | undefined {
	return resolveSignedTokenKey(explicit);
}

/**
 * Whether this deployment can emit and verify CFBL addresses. Without a signing
 * key we emit NO header at all rather than an unsigned, forgeable one — an
 * unsigned complaint handle is strictly worse than none.
 */
export function isCfblSigningEnabled(key?: string): boolean {
	return resolveCfblKey(key) !== undefined;
}

/**
 * Build the signed CFBL token (the local-part suffix, `{encodedId}+{mac}`).
 *
 * Returns `null` when there is no signing key or the message id is absent /
 * implausibly long — the caller then emits no header.
 */
export function buildCfblToken(
	messageId: string,
	key?: string,
	now: number = Date.now()
): string | null {
	if (messageId.length === 0 || messageId.length > MAX_MESSAGE_ID_LENGTH) return null;
	const signingKey = resolveCfblKey(key);
	if (!signingKey) return null;
	const encoded = Buffer.from(messageId).toString('base64url');
	const mac = computeSignedTokenMac(
		CFBL_MAC_LABEL,
		encoded,
		currentSignedTokenWindow(now),
		signingKey
	);
	return `${encoded}+${mac}`;
}

/**
 * Build the advertised complaint feedback address for a send.
 *
 * @param messageId the send's internal message id (the attribution handle)
 * @param cfblDomain the domain that receives complaint reports (the same
 *   return-path host the VERP bounce address uses — its MX already points at
 *   the bounce SMTP server and `fbl+` is already accepted at RCPT time)
 */
export function buildCfblAddress(
	messageId: string,
	cfblDomain: string,
	key?: string,
	now: number = Date.now()
): string | null {
	if (cfblDomain.length === 0) return null;
	const token = buildCfblToken(messageId, key, now);
	if (!token) return null;
	const address = `${CFBL_LOCAL_PREFIX}+${token}@${cfblDomain}`;
	return address.length <= MAX_ADDRESS_LENGTH ? address : null;
}

/**
 * Render the RFC 9477 §4.1 header value: the address plus the mandatory
 * `report=` parameter naming the report format we accept.
 */
export function buildCfblHeaderValue(address: string): string {
	return `${address}; report=${CFBL_REPORT_FORMAT}`;
}

/** RFC 9477 §4.1 header advertising where to send complaint reports. */
export const CFBL_ADDRESS_HEADER = 'CFBL-Address';

/** RFC 9477 §4.2 optional opaque companion identifier. */
export const CFBL_FEEDBACK_ID_HEADER = 'CFBL-Feedback-ID';

/**
 * Whether a CFBL host may be advertised for a message whose `RFC5322.From`
 * carries `fromDomain`.
 *
 * RFC 9477 §3.1.2 lets the CFBL address sit on the From domain or on a SUBDOMAIN
 * of it under the signature that already covers From. §3.1.3 permits any other
 * domain ONLY if the message carries an ADDITIONAL valid DKIM signature whose
 * `d=` matches the CFBL host — and if neither holds, the mailbox provider
 * "SHALL NOT send a report message".
 *
 * Owlat signs once, with `d=` aligned to the sending domain, so the second
 * signature of §3.1.3 does not exist. Advertising a header on the shared global
 * return-path host would therefore publish a complaint handle that every
 * conforming provider discards — the worst outcome available, because it looks
 * like a shipped feature and produces no signal. So the header is emitted only
 * on the aligned branch: a tenant that registers a per-domain return-path host
 * (`smtp/dkimStore.ts`) gets RFC 9477 complaint feedback, and one that has not
 * gets silence rather than a decorative header.
 *
 * Absence is not an error state (D2): no throw, no warning, no nag — the send
 * proceeds byte-for-byte as it did before the header existed.
 */
export function isCfblHostAlignedWithFrom(cfblHost: string, fromDomain: string): boolean {
	if (cfblHost.length === 0 || fromDomain.length === 0) return false;
	const host = cfblHost.toLowerCase();
	const from = fromDomain.toLowerCase();
	return host === from || host.endsWith(`.${from}`);
}

/** Inputs for {@link buildCfblHeaders}. */
export interface CfblHeaderInput {
	/** The send's internal message id — the attribution handle inside the token. */
	readonly messageId: string;
	/** Host that receives complaint reports (the VERP return-path host). */
	readonly cfblHost: string;
	/** Domain of `RFC5322.From`, which the CFBL host must align with. */
	readonly fromDomain: string;
	/** Signing key (defaults to `BOUNCE_VERP_KEY`). */
	readonly key?: string | undefined;
	/** Injectable clock for the signing window. */
	readonly now?: number | undefined;
}

/**
 * Build the outbound RFC 9477 header set for one send.
 *
 * Returns an EMPTY record when the header cannot be emitted safely: no signing
 * key, no return-path host, an implausible message id, or a CFBL host that is
 * not aligned with the From domain (see {@link isCfblHostAlignedWithFrom}).
 * Emitting the header is unconditional and free otherwise — it depends on no
 * third-party account, no enrollment and no credential, so its absence is never
 * an error state and its presence never blocks a send.
 *
 * `CFBL-Feedback-ID` carries the SAME signed token as the address local-part.
 * RFC 9477 §4.2 asks a report generator to copy it into the ARF's `Feedback-ID`
 * field, which gives attribution a second authenticated path when a provider
 * rewrites the envelope recipient. It is deliberately NOT the Gmail
 * `Feedback-ID` (a stable per-stream aggregation anchor, built in
 * `delivery/sendComposition/feedbackId.ts`) — the two headers answer different
 * questions and coexist.
 *
 * Both fields are covered by the DKIM `h=` tag (`SIGNED_HEADERS` in
 * `@owlat/mail-message`), which RFC 9477 §3.1.4 requires: an uncovered field is
 * one a provider must ignore, and one an intermediary could rewrite to redirect
 * complaints.
 */
export function buildCfblHeaders(input: CfblHeaderInput): Record<string, string> {
	if (!isCfblHostAlignedWithFrom(input.cfblHost, input.fromDomain)) return {};
	const address = buildCfblAddress(input.messageId, input.cfblHost, input.key, input.now);
	if (!address) return {};
	// Reuse the address's local-part suffix rather than signing twice.
	const token = address.slice(CFBL_LOCAL_PREFIX.length + 1, address.lastIndexOf('@'));
	return {
		[CFBL_ADDRESS_HEADER]: buildCfblHeaderValue(address),
		[CFBL_FEEDBACK_ID_HEADER]: token,
	};
}

/**
 * Verify a presented CFBL token (`{encodedId}+{mac}`) and recover the message id.
 *
 * Never throws. Every failure path returns a bounded, loggable reason so the
 * caller can COUNT rejections — a forged-complaint campaign should show up as a
 * metric, not as an exception or (worse) as attribution.
 */
export function parseCfblToken(
	token: string,
	key?: string,
	now: number = Date.now()
): CfblParseResult {
	if (token.length > MAX_ADDRESS_LENGTH) return { ok: false, reason: 'oversized' };
	const match = token.match(/^([A-Za-z0-9_-]+)(?:\+([A-Za-z0-9_-]+))?$/);
	const encodedId = match?.[1];
	if (!encodedId) return { ok: false, reason: 'not_cfbl' };
	const presentedMac = match?.[2];

	const signingKey = resolveCfblKey(key);
	// No key → we cannot distinguish our own token from a forgery, so nothing is
	// trusted. This is a deployment misconfiguration, not a report defect.
	if (!signingKey) return { ok: false, reason: 'unverifiable' };
	if (!presentedMac) return { ok: false, reason: 'unsigned' };

	const windowAge = findSignedTokenWindowAge({
		label: CFBL_MAC_LABEL,
		encodedId,
		presentedMac,
		key: signingKey,
		now,
		pastWindows: EXPIRY_PROBE_WINDOWS,
		futureWindows: ACCEPTED_FUTURE_WINDOWS,
	});
	if (windowAge === null) return { ok: false, reason: 'bad_signature' };
	if (windowAge > ACCEPTED_PAST_WINDOWS) return { ok: false, reason: 'expired' };

	const decoded = decodeMessageId(encodedId);
	return decoded === null
		? { ok: false, reason: 'malformed_payload' }
		: { ok: true, messageId: decoded };
}

/**
 * Verify a full presented CFBL address (`fbl+{token}@{host}`) and recover the
 * message id. The host is intentionally NOT part of the MAC: a deployment may
 * register a per-sending-domain return-path host (see `smtp/dkimStore.ts`), and
 * a report arriving at any of them must still attribute — exactly the posture
 * `parseVerpAddress` takes for bounces.
 */
export function parseCfblAddress(
	address: string,
	key?: string,
	now: number = Date.now()
): CfblParseResult {
	if (address.length > MAX_ADDRESS_LENGTH) return { ok: false, reason: 'oversized' };
	const match = address.match(/^fbl\+([A-Za-z0-9_+-]+)@/);
	const token = match?.[1];
	if (!token) return { ok: false, reason: 'not_cfbl' };
	return parseCfblToken(token, key, now);
}

/**
 * Decode the base64url payload back to a message id, rejecting anything that is
 * not a short, printable-ASCII identifier. base64url decoding is lenient (it
 * silently drops invalid characters), so the decoded bytes are re-validated
 * rather than trusted — a MAC-verified token is authentic, but a bug elsewhere
 * must still not put arbitrary bytes into a Redis key or a log line.
 */
function decodeMessageId(encodedId: string): string | null {
	if (encodedId.length > MAX_MESSAGE_ID_LENGTH * 2) return null;
	let decoded: string;
	try {
		decoded = Buffer.from(encodedId, 'base64url').toString('utf-8');
	} catch {
		return null;
	}
	if (decoded.length === 0 || decoded.length > MAX_MESSAGE_ID_LENGTH) return null;
	// eslint-disable-next-line no-control-regex
	return /^[\x21-\x7E]+$/.test(decoded) ? decoded : null;
}
