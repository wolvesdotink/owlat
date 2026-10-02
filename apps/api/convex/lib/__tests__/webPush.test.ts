import { describe, expect, it } from 'vitest';
import {
	buildPushRequest,
	classifyPushResponse,
	encryptPushPayload,
	MAX_PUSH_PAYLOAD_BYTES,
	pushTopic,
	vapidAuthorization,
} from '../webPush';
import { base64UrlToBytes, bytesToBase64Url, utf8Bytes } from '../bytes';

// RFC 8291 Appendix A — the worked example, byte for byte.
const RFC = {
	plaintext: 'When I grow up, I want to be a watermelon',
	asPublic:
		'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
	asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
	uaPublic:
		'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
	uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
	salt: 'DGv6ra1nlYgDCS1FRnbzlw',
	authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
	body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/** Decrypt an aes128gcm body as the user agent would (RFC 8291 §3.4, receiver side). */
async function decryptAsUserAgent(
	body: Uint8Array,
	uaPrivate: string,
	uaPublic: string,
	auth: string
) {
	const salt = body.slice(0, 16);
	const idLength = body[20]!;
	const asPublic = body.slice(21, 21 + idLength);
	const ciphertext = body.slice(21 + idLength);
	const uaPublicBytes = base64UrlToBytes(uaPublic);
	const uaKey = await crypto.subtle.importKey(
		'jwk',
		{
			kty: 'EC',
			crv: 'P-256',
			d: uaPrivate,
			x: bytesToBase64Url(uaPublicBytes.slice(1, 33)),
			y: bytesToBase64Url(uaPublicBytes.slice(33)),
		},
		{ name: 'ECDH', namedCurve: 'P-256' },
		false,
		['deriveBits']
	);
	const asKey = await crypto.subtle.importKey(
		'raw',
		asPublic,
		{ name: 'ECDH', namedCurve: 'P-256' },
		false,
		[]
	);
	const secret = new Uint8Array(
		await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, uaKey, 256)
	);
	const derive = async (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) => {
		const key = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, [
			'deriveBits',
		]);
		return new Uint8Array(
			await crypto.subtle.deriveBits(
				{ name: 'HKDF', hash: 'SHA-256', salt: s as BufferSource, info: info as BufferSource },
				key,
				bytes * 8
			)
		);
	};
	const keyInfo = new Uint8Array([...utf8Bytes('WebPush: info\0'), ...uaPublicBytes, ...asPublic]);
	const ikm = await derive(base64UrlToBytes(auth), secret, keyInfo, 32);
	const cek = await derive(salt, ikm, utf8Bytes('Content-Encoding: aes128gcm\0'), 16);
	const nonce = await derive(salt, ikm, utf8Bytes('Content-Encoding: nonce\0'), 12);
	const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
	const padded = new Uint8Array(
		await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, ciphertext)
	);
	expect(padded[padded.length - 1]).toBe(0x02);
	return new TextDecoder().decode(padded.slice(0, -1));
}

async function newVapidKeys() {
	const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
		'sign',
		'verify',
	])) as CryptoKeyPair;
	const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
	const publicKey = bytesToBase64Url(
		new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
	);
	return { publicKey, privateKey: jwk.d!, subject: 'mailto:postmaster@example.com', pair };
}

describe('encryptPushPayload', () => {
	it('reproduces the RFC 8291 Appendix A example exactly', async () => {
		const body = await encryptPushPayload(
			{ p256dh: RFC.uaPublic, auth: RFC.authSecret },
			utf8Bytes(RFC.plaintext),
			{
				salt: base64UrlToBytes(RFC.salt),
				senderKey: { publicKey: RFC.asPublic, privateKey: RFC.asPrivate },
			}
		);
		expect(bytesToBase64Url(body)).toBe(RFC.body);
	});

	it('uses a fresh key and salt per message that the user agent can still open', async () => {
		const target = { p256dh: RFC.uaPublic, auth: RFC.authSecret };
		const first = await encryptPushPayload(target, utf8Bytes('hello'));
		const second = await encryptPushPayload(target, utf8Bytes('hello'));
		expect(bytesToBase64Url(first)).not.toBe(bytesToBase64Url(second));
		// salt(16) + record size(4) + key id length(1) + key id(65)
		expect(new DataView(first.buffer).getUint32(16)).toBe(4096);
		expect(first[20]).toBe(65);
		await expect(
			decryptAsUserAgent(first, RFC.uaPrivate, RFC.uaPublic, RFC.authSecret)
		).resolves.toBe('hello');
	});

	it('refuses a payload that would not fit one record', async () => {
		await expect(
			encryptPushPayload(
				{ p256dh: RFC.uaPublic, auth: RFC.authSecret },
				new Uint8Array(MAX_PUSH_PAYLOAD_BYTES + 1)
			)
		).rejects.toThrow(/exceeds/);
	});

	it('refuses a subscription key that is not an uncompressed P-256 point', async () => {
		await expect(
			encryptPushPayload(
				{ p256dh: bytesToBase64Url(new Uint8Array(33)), auth: RFC.authSecret },
				utf8Bytes('x')
			)
		).rejects.toThrow(/P-256/);
	});
});

describe('vapidAuthorization', () => {
	it('signs an ES256 JWT for the endpoint origin that verifies under the public key', async () => {
		const keys = await newVapidKeys();
		const now = Date.UTC(2026, 9, 2, 12, 0, 0);
		const header = await vapidAuthorization(
			'https://fcm.googleapis.com/fcm/send/abc:def',
			keys,
			now
		);
		const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
		expect(match).not.toBeNull();
		const [jwtHeader, jwtClaims, jwtSignature] = match![1]!.split('.');
		expect(match![2]).toBe(keys.publicKey);
		const claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(jwtClaims!)));
		expect(claims).toEqual({
			aud: 'https://fcm.googleapis.com',
			exp: now / 1000 + 12 * 60 * 60,
			sub: 'mailto:postmaster@example.com',
		});
		expect(JSON.parse(new TextDecoder().decode(base64UrlToBytes(jwtHeader!)))).toEqual({
			typ: 'JWT',
			alg: 'ES256',
		});
		const verified = await crypto.subtle.verify(
			{ name: 'ECDSA', hash: 'SHA-256' },
			keys.pair.publicKey,
			base64UrlToBytes(jwtSignature!),
			utf8Bytes(`${jwtHeader}.${jwtClaims}`)
		);
		expect(verified).toBe(true);
	});
});

describe('buildPushRequest', () => {
	it('carries the aes128gcm coding, TTL, urgency and a hashed topic', async () => {
		const keys = await newVapidKeys();
		const request = await buildPushRequest(
			{ endpoint: 'https://push.example.com/abc', p256dh: RFC.uaPublic, auth: RFC.authSecret },
			'{"title":"Ada"}',
			keys,
			{ ttlSeconds: 3600, urgency: 'high', topic: 'mail:thread_1', nowMs: Date.now() }
		);
		expect(request.endpoint).toBe('https://push.example.com/abc');
		expect(request.headers['Content-Encoding']).toBe('aes128gcm');
		expect(request.headers['TTL']).toBe('3600');
		expect(request.headers['Urgency']).toBe('high');
		expect(request.headers['Topic']).toBe(await pushTopic('mail:thread_1'));
		expect(request.headers['Topic']).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect(request.headers['Authorization']).toMatch(/^vapid t=/);
		await expect(
			decryptAsUserAgent(request.body, RFC.uaPrivate, RFC.uaPublic, RFC.authSecret)
		).resolves.toBe('{"title":"Ada"}');
	});
});

describe('classifyPushResponse', () => {
	it('prunes on 404/410, retries nothing on other 4xx, treats 429/5xx as transient', () => {
		expect(classifyPushResponse(201)).toBe('delivered');
		expect(classifyPushResponse(404)).toBe('gone');
		expect(classifyPushResponse(410)).toBe('gone');
		expect(classifyPushResponse(413)).toBe('rejected');
		expect(classifyPushResponse(403)).toBe('rejected');
		expect(classifyPushResponse(429)).toBe('failed');
		expect(classifyPushResponse(503)).toBe('failed');
	});
});
