/**
 * AWS SES / SNS webhook adapter — verifies SNS message signatures FAIL-CLOSED
 * and parses SES bounce / complaint / delivery notifications into
 * InboundEvent. See CONTEXT.md "Inbound adapter".
 *
 * SES publishes bounce, complaint and delivery feedback through Amazon SNS.
 * Each POST to `/webhooks/ses` is an SNS envelope of one of three `Type`s:
 *   - `SubscriptionConfirmation` — sent once when the HTTPS subscription is
 *     created; confirmed by GET-ing its `SubscribeURL`. Parsed into the
 *     `internal.sns_subscription_confirm` InboundEvent so the dispatcher (which
 *     has network access) performs the host-pinned confirm fetch.
 *   - `Notification` — the actual SES event. Its `Message` field is itself a
 *     JSON string carrying `notificationType` (`Bounce` / `Complaint` /
 *     `Delivery`) and the originating `mail.messageId` (which equals the
 *     provider message id we stored at send time), so events route into the
 *     same suppression + reputation paths the MTA / Resend webhooks feed.
 *   - `UnsubscribeConfirmation` — acknowledged and ignored.
 *
 * Signature verification is MANDATORY and fail-closed: an envelope with a
 * missing / malformed signature, a `SigningCertURL` that is not an SNS host, or
 * a signature that does not verify against the fetched X.509 certificate's
 * public key is rejected with 401. SNS redelivers, so every downstream write is
 * idempotent (suppression insert + lifecycle transition are both idempotent).
 */

import { getOptional } from '../../lib/env';
import type { InboundAdapter } from '../pipeline';
import type { InboundEvent } from '../types';

/** SNS message envelope (only the fields we read are declared). */
interface SnsEnvelope {
	Type?: string;
	MessageId?: string;
	Token?: string;
	TopicArn?: string;
	Subject?: string;
	Message?: string;
	Timestamp?: string;
	SignatureVersion?: string;
	Signature?: string;
	SigningCertURL?: string;
	SubscribeURL?: string;
}

/** SES notification payload carried (JSON-encoded) inside `SnsEnvelope.Message`. */
interface SesNotification {
	notificationType?: string;
	eventType?: string;
	mail?: { messageId?: string; timestamp?: string };
	bounce?: {
		bounceType?: string;
		timestamp?: string;
		bouncedRecipients?: Array<{ emailAddress?: string; diagnosticCode?: string }>;
	};
	complaint?: {
		timestamp?: string;
		complainedRecipients?: Array<{ emailAddress?: string }>;
	};
	delivery?: { timestamp?: string };
}

/**
 * AWS SNS signing-host pattern (mirrors the AWS SDK's own check). Pins the
 * `SigningCertURL` and `SubscribeURL` to a genuine SNS endpoint so a forged
 * envelope cannot point us at an attacker-controlled certificate or make us
 * GET an arbitrary URL (SSRF). Covers the standard and China partitions.
 */
const SNS_HOST_PATTERN = /^sns\.[a-z0-9-]{3,}\.amazonaws\.com(\.cn)?$/;

/**
 * Whether `rawUrl` is an HTTPS URL on a genuine SNS host. Used to pin both the
 * `SigningCertURL` (before fetching the cert) and the `SubscribeURL` (before
 * confirming the subscription).
 */
export function isAllowedSnsHost(rawUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return false;
	}
	if (url.protocol !== 'https:') return false;
	return SNS_HOST_PATTERN.test(url.hostname.toLowerCase());
}

/**
 * Build the canonical string SNS signs, per the documented field order for the
 * message `Type`. Returns null when a required field is absent (an envelope we
 * cannot verify — reject it) or the `Type` is unknown.
 * https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 */
export function buildSnsCanonicalString(msg: SnsEnvelope): string | null {
	let keys: Array<keyof SnsEnvelope>;
	if (msg.Type === 'Notification') {
		keys =
			msg.Subject !== undefined
				? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
				: ['Message', 'MessageId', 'Timestamp', 'TopicArn', 'Type'];
	} else if (msg.Type === 'SubscriptionConfirmation' || msg.Type === 'UnsubscribeConfirmation') {
		keys = ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
	} else {
		return null;
	}

	let out = '';
	for (const key of keys) {
		const value = msg[key];
		if (value === undefined) return null;
		out += `${key}\n${value}\n`;
	}
	return out;
}

function base64ToBytes(b64: string): Uint8Array {
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Decode a PEM-armored certificate into its DER bytes. */
function pemToDer(pem: string): Uint8Array {
	const body = pem
		.replace(/-----BEGIN CERTIFICATE-----/g, '')
		.replace(/-----END CERTIFICATE-----/g, '')
		.replace(/\s+/g, '');
	return base64ToBytes(body);
}

interface DerTlv {
	tag: number;
	headerLen: number;
	length: number;
	contentStart: number;
}

function readDerTlv(buf: Uint8Array, offset: number): DerTlv {
	const tag = buf[offset];
	const lengthByte = buf[offset + 1];
	if (tag === undefined || lengthByte === undefined) {
		throw new Error('Malformed DER: truncated TLV header');
	}
	if (lengthByte < 0x80) {
		return { tag, headerLen: 2, length: lengthByte, contentStart: offset + 2 };
	}
	const numBytes = lengthByte & 0x7f;
	let length = 0;
	for (let i = 0; i < numBytes; i++) {
		const b = buf[offset + 2 + i];
		if (b === undefined) throw new Error('Malformed DER: truncated length');
		length = length * 256 + b;
	}
	return { tag, headerLen: 2 + numBytes, length, contentStart: offset + 2 + numBytes };
}

/**
 * Extract the SubjectPublicKeyInfo (SPKI) DER from an X.509 certificate DER so
 * it can be imported with Web Crypto's `importKey('spki', …)` — SNS ships a
 * full X.509 cert, but Web Crypto imports only the bare SPKI.
 *
 * Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }
 * TBSCertificate ::= SEQUENCE { [0] version?, serialNumber, signature, issuer,
 *   validity, subject, subjectPublicKeyInfo, … } — SPKI is the element five
 * positions after the (optional) version tag.
 */
export function extractSpkiDer(certDer: Uint8Array): Uint8Array {
	const cert = readDerTlv(certDer, 0);
	const tbs = readDerTlv(certDer, cert.contentStart);
	const end = tbs.contentStart + tbs.length;

	const children: Array<{ tag: number; start: number; totalLen: number }> = [];
	let pos = tbs.contentStart;
	while (pos < end) {
		const tlv = readDerTlv(certDer, pos);
		const totalLen = tlv.headerLen + tlv.length;
		children.push({ tag: tlv.tag, start: pos, totalLen });
		pos += totalLen;
	}

	// Skip the optional context-specific [0] EXPLICIT version tag (0xA0).
	const first = children[0];
	const base = first && first.tag === 0xa0 ? 1 : 0;
	// serialNumber(+0) signature(+1) issuer(+2) validity(+3) subject(+4) spki(+5)
	const spki = children[base + 5];
	if (!spki) throw new Error('Malformed certificate: SubjectPublicKeyInfo not found');
	return certDer.subarray(spki.start, spki.start + spki.totalLen);
}

function hashForSignatureVersion(version: string | undefined): 'SHA-1' | 'SHA-256' | null {
	if (version === '1') return 'SHA-1';
	if (version === '2') return 'SHA-256';
	return null;
}

/** Cache imported public keys per cert URL — SNS reuses one cert across events. */
const certKeyCache = new Map<string, CryptoKey>();

async function defaultGetSnsPublicKey(
	certUrl: string,
	hash: 'SHA-1' | 'SHA-256'
): Promise<CryptoKey | null> {
	const cacheKey = `${certUrl}|${hash}`;
	const cached = certKeyCache.get(cacheKey);
	if (cached) return cached;
	try {
		const res = await fetch(certUrl);
		if (!res.ok) return null;
		const pem = await res.text();
		const spki = extractSpkiDer(pemToDer(pem));
		const key = await crypto.subtle.importKey(
			'spki',
			spki as BufferSource,
			{ name: 'RSASSA-PKCS1-v1_5', hash },
			false,
			['verify']
		);
		certKeyCache.set(cacheKey, key);
		return key;
	} catch {
		return null;
	}
}

/**
 * Injectable key resolver — production fetches + imports the SNS cert; tests
 * supply their own RSA public key so signature verification is exercised
 * without an X.509 round-trip.
 */
export type SnsPublicKeyResolver = (
	certUrl: string,
	hash: 'SHA-1' | 'SHA-256'
) => Promise<CryptoKey | null>;

/**
 * Verify an SNS envelope's signature FAIL-CLOSED. Rejects (returns false) when
 * the signature version is unknown, required fields are missing, the
 * `SigningCertURL` is not a genuine SNS host, the cert cannot be resolved, or
 * the signature does not verify.
 */
export async function verifySnsMessage(
	msg: SnsEnvelope,
	getPublicKey: SnsPublicKeyResolver = defaultGetSnsPublicKey
): Promise<boolean> {
	const hash = hashForSignatureVersion(msg.SignatureVersion);
	if (!hash) return false;
	if (!msg.Signature || !msg.SigningCertURL) return false;
	if (!isAllowedSnsHost(msg.SigningCertURL)) return false;

	const canonical = buildSnsCanonicalString(msg);
	if (canonical === null) return false;

	let signature: Uint8Array;
	try {
		signature = base64ToBytes(msg.Signature);
	} catch {
		return false;
	}

	const key = await getPublicKey(msg.SigningCertURL, hash);
	if (!key) return false;

	try {
		return await crypto.subtle.verify(
			'RSASSA-PKCS1-v1_5',
			key,
			signature as BufferSource,
			new TextEncoder().encode(canonical)
		);
	} catch {
		return false;
	}
}

function parseTimestamp(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? fallback : ms;
}

export const sesAdapter: InboundAdapter = {
	source: 'ses',

	async verifySignature(_request, rawBody) {
		// SES feedback is opt-in per deployment: gate the endpoint on the same
		// SES credential the send path requires, so an instance that never
		// configured SES rejects (503) rather than silently accepting forged
		// feedback. Mirrors the other adapters' "not configured securely" gate.
		if (!getOptional('AWS_SES_REGION')) {
			return {
				ok: false,
				status: 503,
				reason: 'Webhook endpoint is not configured securely (SES is not configured)',
			};
		}

		let msg: SnsEnvelope;
		try {
			msg = JSON.parse(rawBody) as SnsEnvelope;
		} catch {
			return { ok: false, status: 400, reason: 'Invalid SNS payload' };
		}

		const isValid = await verifySnsMessage(msg);
		if (!isValid) {
			return { ok: false, status: 401, reason: 'Invalid SNS message signature' };
		}
		return { ok: true };
	},

	parseEvent(rawBody): InboundEvent | null {
		const msg = JSON.parse(rawBody) as SnsEnvelope;

		if (msg.Type === 'SubscriptionConfirmation') {
			// The dispatcher (network-capable) confirms by GET-ing SubscribeURL.
			if (!msg.SubscribeURL || !isAllowedSnsHost(msg.SubscribeURL)) return null;
			return { kind: 'internal.sns_subscription_confirm', subscribeUrl: msg.SubscribeURL };
		}

		if (msg.Type !== 'Notification' || !msg.Message) return null;

		let notification: SesNotification;
		try {
			notification = JSON.parse(msg.Message) as SesNotification;
		} catch {
			return null;
		}

		// Configuration-Set event publishing uses `eventType`; the SNS-topic
		// feedback path uses `notificationType`. Accept either.
		const kind = notification.notificationType ?? notification.eventType;
		const providerMessageId = notification.mail?.messageId;
		const envelopeAt = parseTimestamp(msg.Timestamp, Date.now());
		const at = parseTimestamp(notification.mail?.timestamp, envelopeAt);

		switch (kind) {
			case 'Bounce': {
				if (!providerMessageId) return null;
				const bounceType = notification.bounce?.bounceType === 'Permanent' ? 'hard' : 'soft';
				const diagnostic = notification.bounce?.bouncedRecipients?.[0]?.diagnosticCode;
				return {
					kind: 'email.bounced',
					providerMessageId,
					at: parseTimestamp(notification.bounce?.timestamp, at),
					bounceType,
					...(diagnostic ? { bounceMessage: diagnostic } : {}),
				};
			}
			case 'Complaint': {
				const complaintAt = parseTimestamp(notification.complaint?.timestamp, at);
				if (providerMessageId) {
					return { kind: 'email.complained', providerMessageId, at: complaintAt };
				}
				// No recoverable Message-ID → suppress by the complained address so
				// the complaint still reaches the blocklist (RFC 5965 §3.2 parity
				// with the MTA path).
				const recipient = notification.complaint?.complainedRecipients?.[0]?.emailAddress;
				if (recipient) {
					return { kind: 'email.complained', recipient, at: complaintAt };
				}
				return null;
			}
			case 'Delivery': {
				if (!providerMessageId) return null;
				return {
					kind: 'email.delivered',
					providerMessageId,
					at: parseTimestamp(notification.delivery?.timestamp, at),
				};
			}
			default:
				return null;
		}
	},
};
