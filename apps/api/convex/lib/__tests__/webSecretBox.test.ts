/**
 * webSecretBox — the shared V8 sealing core.
 *
 * Its consumers (at-rest bodies, import credentials, plugin storage cursors)
 * all derive from the SAME `INSTANCE_SECRET`, so the only thing keeping their
 * ciphertexts apart is the HKDF salt/info pair. These tests pin that isolation,
 * the AAD binding the cursor relies on, and the strictness of the keyless
 * envelope parse that decides "sealed" vs "attacker-controlled plaintext".
 */

import { describe, it, expect } from 'vitest';
import {
	createWebSecretBox,
	formatTextEnvelope,
	parseTextEnvelope,
	toBase64,
	tryFromBase64,
} from '../webSecretBox';

const SECRET = 'shared-instance-secret-for-webSecretBox-tests';
const CANARY = 'CANARY-webSecretBox-plaintext-4b21';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('createWebSecretBox', () => {
	it('round-trips bytes and never emits the plaintext', async () => {
		const box = createWebSecretBox(SECRET, { salt: 's:v1', info: 'i:v1' });
		const sealed = await box.sealBytes(encoder.encode(CANARY));
		expect(toBase64(sealed.ciphertext)).not.toContain(toBase64(encoder.encode(CANARY)));
		expect(decoder.decode(await box.openBytes(sealed))).toBe(CANARY);
	});

	it('appends the 16-byte GCM tag and draws a fresh 12-byte nonce per seal', async () => {
		const box = createWebSecretBox(SECRET, { salt: 's:v1', info: 'i:v1' });
		const first = await box.sealBytes(encoder.encode(CANARY));
		const second = await box.sealBytes(encoder.encode(CANARY));
		expect(first.iv.length).toBe(12);
		expect(first.ciphertext.length).toBe(encoder.encode(CANARY).length + 16);
		expect(toBase64(first.iv)).not.toBe(toBase64(second.iv));
		expect(toBase64(first.ciphertext)).not.toBe(toBase64(second.ciphertext));
	});

	it('isolates two contexts derived from the same secret (differing info)', async () => {
		const a = createWebSecretBox(SECRET, { salt: 'same:salt', info: 'context:a' });
		const b = createWebSecretBox(SECRET, { salt: 'same:salt', info: 'context:b' });
		await expect(b.openBytes(await a.sealBytes(encoder.encode(CANARY)))).rejects.toThrow();
	});

	it('isolates two contexts derived from the same secret (differing salt)', async () => {
		const a = createWebSecretBox(SECRET, { salt: 'salt:a', info: 'same:info' });
		const b = createWebSecretBox(SECRET, { salt: 'salt:b', info: 'same:info' });
		await expect(b.openBytes(await a.sealBytes(encoder.encode(CANARY)))).rejects.toThrow();
	});

	it('binds additional authenticated data: a mismatch fails the tag', async () => {
		const box = createWebSecretBox(SECRET, { salt: 's:v1', info: 'i:v1' });
		const sealed = await box.sealBytes(encoder.encode(CANARY), encoder.encode('tenant-a'));
		await expect(box.openBytes(sealed, encoder.encode('tenant-b'))).rejects.toThrow();
		// Omitting the AAD entirely is also a mismatch, not a bypass.
		await expect(box.openBytes(sealed)).rejects.toThrow();
		expect(decoder.decode(await box.openBytes(sealed, encoder.encode('tenant-a')))).toBe(CANARY);
	});

	it('rejects a flipped ciphertext bit (authenticated, not merely encrypted)', async () => {
		const box = createWebSecretBox(SECRET, { salt: 's:v1', info: 'i:v1' });
		const sealed = await box.sealBytes(encoder.encode(CANARY));
		const tampered = new Uint8Array(sealed.ciphertext);
		tampered.set([(tampered[0] ?? 0) ^ 0x01], 0);
		await expect(box.openBytes({ iv: sealed.iv, ciphertext: tampered })).rejects.toThrow();
	});
});

describe('parseTextEnvelope', () => {
	const sample = { iv: new Uint8Array(12).fill(7), ciphertext: new Uint8Array(24).fill(9) };
	const envelope = formatTextEnvelope('atrest', 1, sample);

	it('round-trips what formatTextEnvelope produced', () => {
		const parsed = parseTextEnvelope('atrest', 1, envelope);
		expect(parsed).not.toBeNull();
		expect(toBase64(parsed!.iv)).toBe(toBase64(sample.iv));
		expect(toBase64(parsed!.ciphertext)).toBe(toBase64(sample.ciphertext));
	});

	it('rejects the wrong prefix, the wrong version, and extra segments', () => {
		expect(parseTextEnvelope('impcred', 1, envelope)).toBeNull();
		expect(parseTextEnvelope('atrest', 2, envelope)).toBeNull();
		expect(parseTextEnvelope('atrest', 1, `${envelope}:extra`)).toBeNull();
	});

	it('rejects a short IV and a ciphertext below the GCM tag length', () => {
		const shortIv = `atrest:1:${toBase64(new Uint8Array(11))}:${toBase64(sample.ciphertext)}`;
		const shortCt = `atrest:1:${toBase64(sample.iv)}:${toBase64(new Uint8Array(15))}`;
		expect(parseTextEnvelope('atrest', 1, shortIv)).toBeNull();
		expect(parseTextEnvelope('atrest', 1, shortCt)).toBeNull();
	});

	it('reads an attacker-controlled plaintext that merely starts with the prefix as plaintext', () => {
		expect(parseTextEnvelope('atrest', 1, 'atrest: see attached invoice')).toBeNull();
		expect(parseTextEnvelope('atrest', 1, 'atrest:1:not base64:also not')).toBeNull();
	});
});

describe('tryFromBase64', () => {
	it('decodes canonical base64 and rejects non-canonical spellings', () => {
		const canonical = toBase64(new Uint8Array([1, 2])); // "AQI=" — padded
		expect(tryFromBase64(canonical)).not.toBeNull();
		expect(tryFromBase64(canonical.replace(/=+$/, ''))).toBeNull(); // padding stripped
		expect(tryFromBase64(` ${canonical}`)).toBeNull(); // whitespace
		expect(tryFromBase64('not base64 at all!')).toBeNull();
	});
});
