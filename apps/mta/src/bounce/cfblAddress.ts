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

import { createHmac, timingSafeEqual } from 'crypto';

/** Envelope local-part prefix for the complaint feedback address. */
export const CFBL_LOCAL_PREFIX = 'fbl';

/** RFC 9477 §4.1 `report=` parameter value: we accept RFC 5965 ARF reports. */
export const CFBL_REPORT_FORMAT = 'arf';

/** Length (chars) of the base64url-encoded truncated HMAC carried in the token. */
const MAC_B64URL_LEN = 14; // ~84 bits

/** Window granularity: one bucket per UTC day. */
const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Past windows accepted in addition to the current one. Complaints are a
 * human-latency signal: a subscriber may report a two-week-old newsletter.
 * 13 prior days + today ≈ a 14-day acceptance horizon.
 */
export const ACCEPTED_PAST_WINDOWS = 13;

/** One future window absorbs signer/verifier clock skew around a day boundary. */
const ACCEPTED_FUTURE_WINDOWS = 1;

/**
 * How far back verification will probe PURELY to classify a rejection as
 * `expired` rather than `bad_signature`. Bounded (90 HMACs worst case) so a
 * flood of junk reports cannot turn this into a CPU amplifier.
 */
const EXPIRY_PROBE_WINDOWS = 90;

/** RFC 5321 §4.5.3.1.3 caps a forward-path at 256 octets; 320 is the whole path. */
const MAX_ADDRESS_LENGTH = 320;

/** Upper bound on an internal message id we are willing to encode or decode. */
const MAX_MESSAGE_ID_LENGTH = 200;

/** RFC 5322 §2.1.1 hard cap on a physical header line, excluding CRLF. */
export const MAX_HEADER_LINE_OCTETS = 998;

/** RFC 5322 §2.1.1 SHOULD cap on a physical header line, excluding CRLF. */
export const RECOMMENDED_HEADER_LINE_OCTETS = 78;

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
	const key = explicit ?? process.env['BOUNCE_VERP_KEY'];
	return key && key.length > 0 ? key : undefined;
}

/**
 * Whether this deployment can emit and verify CFBL addresses. Without a signing
 * key we emit NO header at all rather than an unsigned, forgeable one — an
 * unsigned complaint handle is strictly worse than none.
 */
export function isCfblSigningEnabled(key?: string): boolean {
	return resolveCfblKey(key) !== undefined;
}

function currentWindow(now: number): number {
	return Math.floor(now / WINDOW_MS);
}

/**
 * Truncated base64url MAC over `cfbl:{encodedId}:{window}`.
 *
 * The `cfbl:` label is the domain separator against `verp.ts`'s
 * `{encodedId}:{window}`; signing the ALREADY base64url-encoded id keeps the MAC
 * input free of `@`/`+`/`=` so the token grammar stays unambiguous.
 */
function computeMac(encodedId: string, window: number, key: string): string {
	return createHmac('sha256', key)
		.update(`cfbl:${encodedId}:${window}`)
		.digest('base64url')
		.slice(0, MAC_B64URL_LEN);
}

/** Constant-time compare that never throws on a length mismatch. */
function macsEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
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
	const mac = computeMac(encoded, currentWindow(now), signingKey);
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

/**
 * Recover the address from a `CFBL-Address` header value, ignoring the
 * parameter list. Bounded and non-throwing — this reads internet-supplied bytes
 * when we inspect our own echoed header inside a report.
 */
export function extractCfblAddressFromHeaderValue(value: string): string | null {
	if (value.length === 0 || value.length > MAX_ADDRESS_LENGTH + 64) return null;
	const head = value.split(';', 1)[0];
	if (head === undefined) return null;
	// Unfold any folding white space a receiver left in place, then unwrap <addr>.
	const flattened = head.replace(/\s+/g, '');
	const angle = flattened.match(/^<(.+)>$/);
	const address = angle?.[1] ?? flattened;
	return address.length > 0 && address.length <= MAX_ADDRESS_LENGTH ? address : null;
}

/**
 * Render `Name: value` as RFC 5322 physical lines, folding on the folding white
 * space that follows the `;` parameter separator.
 *
 * The address token itself contains no FWS and therefore cannot be folded — the
 * only legal fold point in a CFBL header is before `report=…`. This helper
 * exists so the emitted value's line geometry is ASSERTABLE: the hard 998-octet
 * cap always holds, and the 78-octet SHOULD holds for realistic domains.
 */
export function foldCfblHeaderLine(name: string, value: string): string[] {
	const single = `${name}: ${value}`;
	if (Buffer.byteLength(single, 'utf-8') <= RECOMMENDED_HEADER_LINE_OCTETS) return [single];
	const separator = value.indexOf('; ');
	if (separator === -1) return [single];
	return [`${name}: ${value.slice(0, separator + 1)}`, ` ${value.slice(separator + 2)}`];
}

/** RFC 9477 §4.1 header advertising where to send complaint reports. */
export const CFBL_ADDRESS_HEADER = 'CFBL-Address';

/** RFC 9477 §4.2 optional opaque companion identifier. */
export const CFBL_FEEDBACK_ID_HEADER = 'CFBL-Feedback-ID';

/**
 * Build the outbound RFC 9477 header set for one send.
 *
 * Returns an EMPTY record when the header cannot be emitted safely (no signing
 * key, no return-path host, an implausible message id). Emitting the header is
 * unconditional and free otherwise — it depends on no third-party account, no
 * enrollment and no credential, so its absence is never an error state and its
 * presence never blocks a send.
 *
 * `CFBL-Feedback-ID` carries the SAME signed token as the address local-part.
 * RFC 9477 §4.2 asks a report generator to copy it into the ARF's `Feedback-ID`
 * field, which gives attribution a second authenticated path when a provider
 * rewrites the envelope recipient. It is deliberately NOT the Gmail
 * `Feedback-ID` (a stable per-stream aggregation anchor, built in
 * `delivery/sendComposition/feedbackId.ts`) — the two headers answer different
 * questions and coexist.
 */
export function buildCfblHeaders(
	messageId: string,
	cfblDomain: string,
	key?: string,
	now: number = Date.now()
): Record<string, string> {
	const address = buildCfblAddress(messageId, cfblDomain, key, now);
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

	const base = currentWindow(now);
	let verifiedWindow: number | null = null;
	for (let i = -ACCEPTED_FUTURE_WINDOWS; i <= EXPIRY_PROBE_WINDOWS; i++) {
		if (macsEqual(computeMac(encodedId, base - i, signingKey), presentedMac)) {
			verifiedWindow = i;
			break;
		}
	}
	if (verifiedWindow === null) return { ok: false, reason: 'bad_signature' };
	if (verifiedWindow > ACCEPTED_PAST_WINDOWS) return { ok: false, reason: 'expired' };

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
