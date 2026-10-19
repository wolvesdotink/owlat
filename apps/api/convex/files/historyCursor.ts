/**
 * The continuation token of `files.history.list`.
 *
 * A page that runs out of budget continues at the next version in the chain,
 * and that version may be one the caller cannot read. Its id is not handed
 * out: the token is that id sealed with AES-256-GCM under INSTANCE_SECRET (the
 * `lib/webSecretBox.ts` construction `plugins/storageCursor.ts` uses), and the
 * GCM additional data binds it to the organization, the caller and the history
 * it was minted for. A token presented with any other `fileId`, by anyone
 * else, or tampered with fails the tag, and `openVersionHistoryCursor`
 * answers every such failure the same way.
 *
 * The nonce is synthetic: an HMAC of the binding and the id. The same page
 * therefore mints the same token every time the query runs, so a live
 * subscription does not see its cursor change on every rerun, and a nonce
 * repeats only for an identical token, which reveals nothing new.
 */

import { getOptional } from '../lib/env';
import { hmacSignature } from '../lib/crypto';
import { base64UrlToBytes, bytesToBase64Url } from '../lib/bytes';
import {
	createWebSecretBox,
	GCM_TAG_BYTES,
	IV_BYTES,
	type WebSecretBox,
} from '../lib/webSecretBox';
import type { Id } from '../_generated/dataModel';

const TOKEN_PREFIX = 'file-history';
const TOKEN_VERSION = '1';
const HKDF_SALT = 'owlat:file-history:cursor:salt:v1';
const HKDF_INFO = 'owlat:file-history:cursor:key:v1';
const AAD_CONTEXT = 'owlat:file-history:cursor:aad:v1';
const NONCE_CONTEXT = 'owlat:file-history:cursor:nonce:v1';
/** A sealed document id is well under this; anything longer is not ours. */
const MAX_TOKEN_CHARS = 512;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Whose walk of which history a token continues. */
export interface VersionHistoryCursorBinding {
	readonly organizationId: string;
	readonly userId: string;
	readonly originId: Id<'semanticFiles'>;
}

function bindingJson(binding: VersionHistoryCursorBinding): string {
	return JSON.stringify([
		AAD_CONTEXT,
		TOKEN_VERSION,
		binding.organizationId,
		binding.userId,
		binding.originId,
	]);
}

function additionalData(binding: VersionHistoryCursorBinding): Uint8Array {
	return encoder.encode(bindingJson(binding));
}

/** The first IV_BYTES of HMAC-SHA256(secret, context, binding, id). */
async function syntheticNonce(
	secret: string,
	binding: VersionHistoryCursorBinding,
	nextId: string
): Promise<Uint8Array<ArrayBuffer>> {
	const mac = await hmacSignature(
		secret,
		JSON.stringify([NONCE_CONTEXT, bindingJson(binding), nextId]),
		'sha256',
		'base64url'
	);
	return base64UrlToBytes(mac).slice(0, IV_BYTES);
}

function instanceSecret(): string | null {
	return getOptional('INSTANCE_SECRET') || null;
}

function cursorBox(secret: string): WebSecretBox {
	return createWebSecretBox(secret, { salt: HKDF_SALT, info: HKDF_INFO });
}

/**
 * Seal `nextId` for `binding`. Null when the instance has no INSTANCE_SECRET:
 * the page then says more versions exist without a way to reach them, rather
 * than handing out a bare id.
 */
export async function sealVersionHistoryCursor(
	binding: VersionHistoryCursorBinding,
	nextId: Id<'semanticFiles'>
): Promise<string | null> {
	const secret = instanceSecret();
	if (!secret) return null;
	const { iv, ciphertext } = await cursorBox(secret).sealBytes(
		encoder.encode(nextId),
		additionalData(binding),
		await syntheticNonce(secret, binding, nextId)
	);
	return [TOKEN_PREFIX, TOKEN_VERSION, bytesToBase64Url(iv), bytesToBase64Url(ciphertext)].join(
		'.'
	);
}

/**
 * The sealed id, or null for anything that is not a token minted for
 * `binding`: malformed, empty, tampered, another history, another caller.
 */
export async function openVersionHistoryCursor(
	binding: VersionHistoryCursorBinding,
	token: string
): Promise<string | null> {
	if (token.length === 0 || token.length > MAX_TOKEN_CHARS) return null;
	const parts = token.split('.');
	if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX || parts[1] !== TOKEN_VERSION) return null;
	const iv = canonicalBase64Url(parts[2]!);
	const ciphertext = canonicalBase64Url(parts[3]!);
	if (!iv || iv.length !== IV_BYTES || !ciphertext || ciphertext.length <= GCM_TAG_BYTES) {
		return null;
	}
	const secret = instanceSecret();
	if (!secret) return null;
	try {
		const plaintext = await cursorBox(secret).openBytes(
			{ iv, ciphertext },
			additionalData(binding)
		);
		return decoder.decode(plaintext);
	} catch {
		return null;
	}
}

function canonicalBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
	try {
		const bytes = base64UrlToBytes(value);
		return bytesToBase64Url(bytes) === value ? bytes : null;
	} catch {
		return null;
	}
}
