/**
 * Minimal crypto helpers shared by the attestation and merkle modules.
 * node:crypto only — the package stays free of third-party dependencies.
 * Keys travel as raw 32-byte ed25519 values (base64); DER framing is an
 * implementation detail kept inside this module.
 */
import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	sign as nodeSign,
	verify as nodeVerify,
} from 'node:crypto';

export function sha256(data: Uint8Array | string): Buffer {
	return createHash('sha256').update(data).digest();
}

/** SPKI DER prefix for an ed25519 public key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
/** PKCS#8 DER prefix for an ed25519 private key (RFC 8410). */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface Ed25519KeyPair {
	/** Raw 32-byte public key, base64. */
	publicKey: string;
	/** Raw 32-byte private key (seed), base64. */
	privateKey: string;
}

export function generateEd25519KeyPair(): Ed25519KeyPair {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const spki = publicKey.export({ type: 'spki', format: 'der' });
	const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });
	return {
		publicKey: Buffer.from(spki.subarray(ED25519_SPKI_PREFIX.length)).toString('base64'),
		privateKey: Buffer.from(pkcs8.subarray(ED25519_PKCS8_PREFIX.length)).toString('base64'),
	};
}

function toPrivateKeyObject(rawBase64: string) {
	const raw = Buffer.from(rawBase64, 'base64');
	if (raw.length !== 32) throw new Error('ed25519 private key must be 32 raw bytes');
	return createPrivateKey({
		key: Buffer.concat([ED25519_PKCS8_PREFIX, raw]),
		format: 'der',
		type: 'pkcs8',
	});
}

function toPublicKeyObject(rawBase64: string) {
	const raw = Buffer.from(rawBase64, 'base64');
	if (raw.length !== 32) throw new Error('ed25519 public key must be 32 raw bytes');
	return createPublicKey({
		key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
		format: 'der',
		type: 'spki',
	});
}

/** Sign `data` with a raw base64 ed25519 private key; returns base64. */
export function ed25519Sign(data: Uint8Array, privateKeyBase64: string): string {
	return nodeSign(null, data, toPrivateKeyObject(privateKeyBase64)).toString('base64');
}

/** Verify a base64 signature with a raw base64 ed25519 public key. */
export function ed25519Verify(
	data: Uint8Array,
	signatureBase64: string,
	publicKeyBase64: string
): boolean {
	let signature: Buffer;
	try {
		signature = Buffer.from(signatureBase64, 'base64');
		return nodeVerify(null, data, toPublicKeyObject(publicKeyBase64), signature);
	} catch {
		return false;
	}
}
