import { describe, expect, it } from 'vitest';
import { ed25519Sign, ed25519Verify, generateEd25519KeyPair, sha256 } from '../crypto.js';

/** A fixed key pair, so signature expectations are reproducible. */
const FIXED_PRIVATE_KEY = 'nWGxne/9WmC6hEr0kuwsxERJxWl7MmkZcDvvQ/nT040=';
const FIXED_PUBLIC_KEY = '7LA40H1E04PS9o11qI3oTmc6dzB0cVVW9n8PgUpa7/c=';

const bytes = (text: string) => Buffer.from(text, 'utf8');

describe('sha256', () => {
	it.each([
		['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
		['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
	])('matches the published digest for %p', (input, digest) => {
		expect(sha256(input).toString('hex')).toBe(digest);
		expect(sha256(bytes(input)).toString('hex')).toBe(digest);
	});

	it('returns 32 bytes and separates inputs that differ in one bit', () => {
		expect(sha256('a')).toHaveLength(32);
		expect(sha256('a').equals(sha256('b'))).toBe(false);
	});
});

describe('generateEd25519KeyPair', () => {
	it('returns raw 32-byte keys in base64', () => {
		const pair = generateEd25519KeyPair();
		expect(Buffer.from(pair.privateKey, 'base64')).toHaveLength(32);
		expect(Buffer.from(pair.publicKey, 'base64')).toHaveLength(32);
	});

	it('produces a distinct pair each call', () => {
		expect(generateEd25519KeyPair().privateKey).not.toBe(generateEd25519KeyPair().privateKey);
	});

	it('produces keys that sign and verify each other and nothing else', () => {
		const alice = generateEd25519KeyPair();
		const mallory = generateEd25519KeyPair();
		const signature = ed25519Sign(bytes('evidence'), alice.privateKey);
		expect(ed25519Verify(bytes('evidence'), signature, alice.publicKey)).toBe(true);
		expect(ed25519Verify(bytes('evidence'), signature, mallory.publicKey)).toBe(false);
	});
});

describe('ed25519 round-trips', () => {
	it.each([
		['empty message', ''],
		['ascii', 'the quick brown fox'],
		['multibyte', 'héllo 🚀 — привет'],
		['long', 'x'.repeat(100_000)],
	])('signs and verifies %s', (_label, message) => {
		const signature = ed25519Sign(bytes(message), FIXED_PRIVATE_KEY);
		expect(Buffer.from(signature, 'base64')).toHaveLength(64);
		expect(ed25519Verify(bytes(message), signature, FIXED_PUBLIC_KEY)).toBe(true);
	});

	it('is deterministic: ed25519 has no per-signature randomness', () => {
		expect(ed25519Sign(bytes('same'), FIXED_PRIVATE_KEY)).toBe(
			ed25519Sign(bytes('same'), FIXED_PRIVATE_KEY)
		);
	});

	it('rejects a message altered by a single byte', () => {
		const signature = ed25519Sign(bytes('report count: 12'), FIXED_PRIVATE_KEY);
		expect(ed25519Verify(bytes('report count: 13'), signature, FIXED_PUBLIC_KEY)).toBe(false);
	});

	it('rejects a signature altered by a single byte', () => {
		const signature = Buffer.from(ed25519Sign(bytes('m'), FIXED_PRIVATE_KEY), 'base64');
		signature[0] = (signature[0] ?? 0) ^ 0x01;
		expect(ed25519Verify(bytes('m'), signature.toString('base64'), FIXED_PUBLIC_KEY)).toBe(false);
	});
});

describe('ed25519 hostile inputs', () => {
	it.each([
		['not base64 at all', 'not a signature'],
		['empty', ''],
		['truncated to 63 bytes', Buffer.alloc(63).toString('base64')],
		['padded to 65 bytes', Buffer.alloc(65).toString('base64')],
	])('answers false for a %s signature instead of throwing', (_label, signature) => {
		expect(ed25519Verify(bytes('m'), signature, FIXED_PUBLIC_KEY)).toBe(false);
	});

	it.each([
		['empty', ''],
		['31 bytes', Buffer.alloc(31).toString('base64')],
		['33 bytes', Buffer.alloc(33).toString('base64')],
		['garbage', '!!!!'],
	])('answers false for a %s public key instead of throwing', (_label, publicKey) => {
		const signature = ed25519Sign(bytes('m'), FIXED_PRIVATE_KEY);
		expect(ed25519Verify(bytes('m'), signature, publicKey)).toBe(false);
	});

	it('refuses to sign with a key that is not 32 raw bytes', () => {
		expect(() => ed25519Sign(bytes('m'), Buffer.alloc(31).toString('base64'))).toThrow(
			/32 raw bytes/
		);
		expect(() => ed25519Sign(bytes('m'), '')).toThrow(/32 raw bytes/);
	});

	it('verifies an all-zero public key as false rather than crashing', () => {
		const signature = ed25519Sign(bytes('m'), FIXED_PRIVATE_KEY);
		expect(ed25519Verify(bytes('m'), signature, Buffer.alloc(32).toString('base64'))).toBe(false);
	});
});
