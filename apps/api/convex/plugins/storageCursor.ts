/**
 * Plugin storage cursor sealing.
 *
 * A native Convex cursor leaks the shape of the underlying page, so a plugin
 * only ever holds an AES-256-GCM token instead. The token is bound to its
 * tenant, plugin, prefix and limit through GCM additional-authenticated-data,
 * so replaying it under any other scope fails the tag rather than paging
 * another tenant's rows.
 *
 * RUNTIME: Web Crypto only. The crypto core is `lib/webSecretBox.ts`, shared
 * with the at-rest body sealer and the integration-import credential sealer;
 * `lib/credentialCrypto.ts`'s `createSecretBox` is the same construction over
 * `node:crypto` and is `'use node'`, so the V8 storage facade cannot use it.
 * What stays local here is the token's base64URL framing (the token travels in
 * plugin-facing JSON, unlike the padded-base64 database envelopes) and the AAD
 * binding.
 */

import { getRequired } from '../lib/env';
import {
	createWebSecretBox,
	GCM_TAG_BYTES,
	IV_BYTES,
	type WebSealedBytes,
	type WebSecretBox,
} from '../lib/webSecretBox';

export const MAX_PLUGIN_STORAGE_CURSOR_CHARS = 8_192;

const TOKEN_PREFIX = 'plugin-storage-cursor';
const TOKEN_VERSION = '1';
const HKDF_SALT = 'owlat:plugin-storage:cursor:salt:v1';
const HKDF_INFO = 'owlat:plugin-storage:cursor:key:v1';
const AAD_CONTEXT = 'owlat:plugin-storage:cursor:aad:v1';
const MAX_CIPHERTEXT_BYTES = 6 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

interface PluginStorageCursorScope {
	readonly organizationId: string;
	readonly pluginId: string;
}

interface PluginStorageCursorRequest {
	readonly prefix: string;
	readonly limit: number;
}

type PluginStorageCursorFailure = 'invalid_token' | 'crypto_unavailable';

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
		const { iv, ciphertext } = await cursorBox().sealBytes(
			encoder.encode(nativeCursor),
			additionalData(scope, request)
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
	let box: WebSecretBox;
	try {
		box = cursorBox();
	} catch {
		throw new PluginStorageCursorError('crypto_unavailable');
	}
	try {
		return decoder.decode(await box.openBytes(envelope, additionalData(scope, request)));
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

/**
 * The cursor box: INSTANCE_SECRET under the pinned, distinct context. Throws
 * the redacted `crypto_unavailable` failure when the instance has no secret, so
 * a misconfigured deployment can never mint an unauthenticated cursor.
 */
function cursorBox(): WebSecretBox {
	let secret: string;
	try {
		secret = getRequired('INSTANCE_SECRET');
	} catch {
		throw new PluginStorageCursorError('crypto_unavailable');
	}
	return createWebSecretBox(secret, { salt: HKDF_SALT, info: HKDF_INFO });
}

function parseToken(value: string): WebSealedBytes {
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
