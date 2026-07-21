import { getRequired } from '../lib/env';

export const MAX_PLUGIN_STORAGE_CURSOR_CHARS = 8_192;

const TOKEN_PREFIX = 'plugin-storage-cursor';
const TOKEN_VERSION = '1';
const HKDF_SALT = 'owlat:plugin-storage:cursor:salt:v1';
const HKDF_INFO = 'owlat:plugin-storage:cursor:key:v1';
const AAD_CONTEXT = 'owlat:plugin-storage:cursor:aad:v1';
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MAX_CIPHERTEXT_BYTES = 6 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface PluginStorageCursorScope {
	readonly organizationId: string;
	readonly pluginId: string;
}

export interface PluginStorageCursorRequest {
	readonly prefix: string;
	readonly limit: number;
}

export type PluginStorageCursorFailure = 'invalid_token' | 'crypto_unavailable';

/** Redacted internal failure; the storage facade maps this to its public taxonomy. */
export class PluginStorageCursorError extends Error {
	readonly failure: PluginStorageCursorFailure;

	constructor(failure: PluginStorageCursorFailure) {
		super('Plugin storage cursor unavailable');
		this.name = 'PluginStorageCursorError';
		this.failure = failure;
	}
}

/** Encrypt and authenticate a native Convex cursor without exposing its contents. */
export async function encryptPluginStorageCursor(
	scope: PluginStorageCursorScope,
	request: PluginStorageCursorRequest,
	nativeCursor: string
): Promise<string> {
	try {
		const key = await deriveEncryptionKey();
		const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
		const ciphertext = new Uint8Array(
			await crypto.subtle.encrypt(
				{
					name: 'AES-GCM',
					iv,
					additionalData: additionalData(scope, request),
				},
				key,
				encoder.encode(nativeCursor)
			)
		);
		if (ciphertext.length > MAX_CIPHERTEXT_BYTES) throw new Error();
		const token = [
			TOKEN_PREFIX,
			TOKEN_VERSION,
			bytesToBase64Url(iv),
			bytesToBase64Url(ciphertext),
		].join('.');
		if (token.length > MAX_PLUGIN_STORAGE_CURSOR_CHARS) throw new Error();
		return token;
	} catch (error) {
		if (error instanceof PluginStorageCursorError) throw error;
		throw new PluginStorageCursorError('crypto_unavailable');
	}
}

/** Authenticate and decrypt a token under its exact tenant/plugin/page scope. */
export async function decryptPluginStorageCursor(
	scope: PluginStorageCursorScope,
	request: PluginStorageCursorRequest,
	token: string
): Promise<string> {
	const envelope = parseToken(token);
	let key: CryptoKey;
	try {
		key = await deriveEncryptionKey();
	} catch {
		throw new PluginStorageCursorError('crypto_unavailable');
	}
	try {
		const plaintext = await crypto.subtle.decrypt(
			{
				name: 'AES-GCM',
				iv: envelope.iv,
				additionalData: additionalData(scope, request),
			},
			key,
			envelope.ciphertext
		);
		return decoder.decode(plaintext);
	} catch {
		throw new PluginStorageCursorError('invalid_token');
	}
}

function additionalData(
	scope: PluginStorageCursorScope,
	request: PluginStorageCursorRequest
): Uint8Array<ArrayBuffer> {
	return encoder.encode(
		JSON.stringify([
			AAD_CONTEXT,
			TOKEN_VERSION,
			scope.organizationId,
			scope.pluginId,
			request.prefix,
			request.limit,
		])
	);
}

async function deriveEncryptionKey(): Promise<CryptoKey> {
	let secret: string;
	try {
		secret = getRequired('INSTANCE_SECRET');
	} catch {
		throw new PluginStorageCursorError('crypto_unavailable');
	}
	const inputKey = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
		'deriveKey',
	]);
	return crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: encoder.encode(HKDF_SALT),
			info: encoder.encode(HKDF_INFO),
		},
		inputKey,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

interface CursorEnvelope {
	readonly iv: Uint8Array<ArrayBuffer>;
	readonly ciphertext: Uint8Array<ArrayBuffer>;
}

function parseToken(value: string): CursorEnvelope {
	const parts = value.split('.');
	if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX || parts[1] !== TOKEN_VERSION) {
		throw new PluginStorageCursorError('invalid_token');
	}
	const iv = tryBase64UrlToBytes(parts[2] ?? '');
	const ciphertext = tryBase64UrlToBytes(parts[3] ?? '');
	if (
		iv === undefined ||
		iv.length !== IV_BYTES ||
		ciphertext === undefined ||
		ciphertext.length < GCM_TAG_BYTES ||
		ciphertext.length > MAX_CIPHERTEXT_BYTES
	) {
		throw new PluginStorageCursorError('invalid_token');
	}
	return { iv, ciphertext };
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function tryBase64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | undefined {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
	try {
		const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
		const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}
		return bytesToBase64Url(bytes) === value ? bytes : undefined;
	} catch {
		return undefined;
	}
}
