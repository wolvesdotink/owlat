/**
 * Standard Web Push, built on Web Crypto: message encryption (RFC 8291, the
 * `aes128gcm` content coding of RFC 8188) and VAPID sender identification
 * (RFC 8292). Pure request construction — the network call and the SSRF guard
 * live with the sender in `push/send.ts`.
 *
 * WHY NOT A LIBRARY. The `web-push` package does exactly this plus an HTTP
 * client, a GCM fallback and a CLI; the protocol itself is two HKDF calls, one
 * AES-GCM seal and one ES256 signature. Keeping it here means no new runtime
 * dependency in the backend bundle, and the test pins the output byte for byte
 * against the RFC 8291 Appendix A example.
 *
 * Runtime-neutral: only `crypto.subtle`, `TextEncoder` and the base64url helpers
 * in `lib/bytes`, so it imports cleanly from either Convex runtime.
 */

import { base64UrlToBytes, bytesToBase64Url, utf8Bytes } from './bytes';

/** One device's subscription, as `PushSubscription.toJSON()` reports it. */
export interface PushTarget {
	endpoint: string;
	/** The user agent's ECDH public key: uncompressed P-256 point, base64url. */
	p256dh: string;
	/** The 16-byte authentication secret, base64url. */
	auth: string;
}

/** The deployment's VAPID identity (see `VAPID_*` in lib/env.ts). */
export interface VapidKeys {
	publicKey: string;
	privateKey: string;
	/** `mailto:` or `https:` contact URI for the push service operator. */
	subject: string;
}

/** Record size written into the aes128gcm header; one record carries the whole payload. */
const RECORD_SIZE = 4096;
/**
 * Largest plaintext one record holds: the record size minus the 16-byte GCM
 * tag and the 1-byte padding delimiter, minus the 86-byte header push services
 * count against the same 4096-byte limit.
 */
export const MAX_PUSH_PAYLOAD_BYTES = RECORD_SIZE - 16 - 1 - 86;
/** VAPID tokens are valid for at most 24 h (RFC 8292 §2); 12 h leaves clock-skew room. */
const VAPID_TOKEN_TTL_SECONDS = 12 * 60 * 60;

type Bytes = Uint8Array<ArrayBuffer>;

function concat(...parts: Uint8Array[]): Bytes {
	const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
	const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'HKDF', hash: 'SHA-256', salt, info },
		key,
		length * 8
	);
	return new Uint8Array(bits);
}

/** An ECDH or ECDSA P-256 private key from its raw scalar plus its public point. */
async function importPrivateKey(
	d: string,
	publicPoint: Bytes,
	algorithm: 'ECDH' | 'ECDSA'
): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'jwk',
		{
			kty: 'EC',
			crv: 'P-256',
			d,
			x: bytesToBase64Url(publicPoint.slice(1, 33)),
			y: bytesToBase64Url(publicPoint.slice(33, 65)),
			ext: true,
		},
		{ name: algorithm, namedCurve: 'P-256' },
		false,
		algorithm === 'ECDH' ? ['deriveBits'] : ['sign']
	);
}

/** Test seam: the RFC example fixes the sender's ephemeral key and the salt. */
export interface EncryptOptions {
	salt?: Bytes;
	senderKey?: { publicKey: string; privateKey: string };
}

/**
 * Encrypt `plaintext` for one subscription (RFC 8291 §3.4): a fresh ephemeral
 * ECDH key and salt per message, keys derived from the shared secret and the
 * subscription's auth secret, a single `aes128gcm` record.
 */
export async function encryptPushPayload(
	target: Pick<PushTarget, 'p256dh' | 'auth'>,
	plaintext: Uint8Array,
	options: EncryptOptions = {}
): Promise<Bytes> {
	if (plaintext.length > MAX_PUSH_PAYLOAD_BYTES) {
		throw new Error(`Push payload of ${plaintext.length} bytes exceeds ${MAX_PUSH_PAYLOAD_BYTES}`);
	}
	const uaPublic = base64UrlToBytes(target.p256dh);
	const authSecret = base64UrlToBytes(target.auth);
	if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
		throw new Error('Subscription key is not an uncompressed P-256 point');
	}

	let asPublic: Bytes;
	let asPrivate: CryptoKey;
	if (options.senderKey) {
		asPublic = base64UrlToBytes(options.senderKey.publicKey);
		asPrivate = await importPrivateKey(options.senderKey.privateKey, asPublic, 'ECDH');
	} else {
		const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
			'deriveBits',
		])) as CryptoKeyPair;
		asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
		asPrivate = pair.privateKey;
	}
	const uaKey = await crypto.subtle.importKey(
		'raw',
		uaPublic,
		{ name: 'ECDH', namedCurve: 'P-256' },
		false,
		[]
	);
	const ecdhSecret = new Uint8Array(
		await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256)
	);

	const keyInfo = concat(utf8Bytes('WebPush: info\0'), uaPublic, asPublic);
	const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
	const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
	const cek = await hkdf(salt, ikm, utf8Bytes('Content-Encoding: aes128gcm\0'), 16);
	const nonce = await hkdf(salt, ikm, utf8Bytes('Content-Encoding: nonce\0'), 12);

	const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
	// 0x02 marks the last (and only) record; no further padding.
	const padded = concat(plaintext, new Uint8Array([0x02]));
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded)
	);

	const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, RECORD_SIZE);
	header[20] = asPublic.length;
	header.set(asPublic, 21);
	return concat(header, ciphertext);
}

/**
 * The `Authorization` header value for a push to `endpoint` (RFC 8292 §3):
 * an ES256 JWT scoped to the push service's origin, plus our public key.
 */
export async function vapidAuthorization(
	endpoint: string,
	keys: VapidKeys,
	nowMs: number
): Promise<string> {
	const header = bytesToBase64Url(utf8Bytes(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
	const claims = bytesToBase64Url(
		utf8Bytes(
			JSON.stringify({
				aud: new URL(endpoint).origin,
				exp: Math.floor(nowMs / 1000) + VAPID_TOKEN_TTL_SECONDS,
				sub: keys.subject,
			})
		)
	);
	const signingInput = `${header}.${claims}`;
	const key = await importPrivateKey(keys.privateKey, base64UrlToBytes(keys.publicKey), 'ECDSA');
	// Web Crypto emits the raw r||s form JWS wants, not DER.
	const signature = new Uint8Array(
		await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8Bytes(signingInput))
	);
	return `vapid t=${signingInput}.${bytesToBase64Url(signature)}, k=${keys.publicKey}`;
}

/**
 * The RFC 8030 `Topic` for a collapse key: push services replace a still
 * undelivered message carrying the same topic, so a burst in one thread reaches
 * a phone that was offline as one notification. A topic is at most 32
 * base64url characters, so the tag is hashed rather than sent as-is (which
 * also keeps thread ids out of the push service's view).
 */
export async function pushTopic(tag: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8Bytes(tag)));
	return bytesToBase64Url(digest).slice(0, 32);
}

/** A ready-to-send push request; the caller supplies the transport. */
export interface PushRequest {
	endpoint: string;
	headers: Record<string, string>;
	body: Bytes;
}

/** Build the full POST for one device: encrypted body, VAPID auth, TTL, urgency, topic. */
export async function buildPushRequest(
	target: PushTarget,
	payload: string,
	keys: VapidKeys,
	options: { ttlSeconds: number; urgency: 'normal' | 'high'; topic?: string; nowMs: number }
): Promise<PushRequest> {
	const body = await encryptPushPayload(target, utf8Bytes(payload));
	const headers: Record<string, string> = {
		Authorization: await vapidAuthorization(target.endpoint, keys, options.nowMs),
		'Content-Encoding': 'aes128gcm',
		'Content-Type': 'application/octet-stream',
		TTL: String(Math.max(0, Math.round(options.ttlSeconds))),
		Urgency: options.urgency,
	};
	if (options.topic) headers['Topic'] = await pushTopic(options.topic);
	return { endpoint: target.endpoint, headers, body };
}

/** What the sender does with the subscription after a push service answered. */
export type PushOutcome = 'delivered' | 'gone' | 'rejected' | 'failed';

/**
 * Classify a push service response (RFC 8030 §5–§7). 404 and 410 mean the
 * subscription no longer exists and must be pruned; other 4xx mean this
 * request was refused (payload, auth) and are worth logging but not retrying;
 * 5xx and 429 are transient.
 */
export function classifyPushResponse(status: number): PushOutcome {
	if (status >= 200 && status < 300) return 'delivered';
	if (status === 404 || status === 410) return 'gone';
	if (status === 429 || status >= 500) return 'failed';
	return 'rejected';
}
