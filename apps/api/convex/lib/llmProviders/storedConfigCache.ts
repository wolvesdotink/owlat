/**
 * In-process cache of the stored AI provider config for `lib/llmProvider`.
 *
 * Holds the `aiProviderConfig` row (or `null` for the env fallback) and each
 * plane's decrypted key. A key is decrypted only when its plane is resolved: a
 * text call never pays for the embedding key, and an embedding call never pays
 * for the language key. Split out of lib/llmProvider.ts to keep that file under
 * the file-size cap. V8-safe: decryption runs in the sibling Node action.
 */

import { internal } from '../../_generated/api';
import type { Doc } from '../../_generated/dataModel';
import type { ActionCtx } from '../../_generated/server';
import { embeddingProviderFor, languageProviderFor } from './index';

// In-process cache. Decrypting a key is a Node action round trip, the slow part
// of resolving, so the row and its decrypted keys live for the full TTL. The row
// read is cheap and repeats every AI_CONFIG_RECHECK_MS: when the admin saves new
// settings, `updatedAt` moves and every isolate drops its cached keys on its
// next recheck (the saving isolate drops them at once, see invalidateAiConfigCache).
const AI_CONFIG_CACHE_TTL_MS = 5 * 60_000;
const AI_CONFIG_RECHECK_MS = 30_000;

/** A decrypted key, with the row identity it was decrypted from. */
interface CachedKey {
	readonly identity: string;
	readonly key: string;
}

export interface ConfigCacheEntry {
	/** The stored row, or `null` for the env `LLM_*` fallback. */
	readonly row: Doc<'aiProviderConfig'> | null;
	readonly fingerprint: string;
	readonly expiresAt: number;
	checkedAt: number;
	/** Decrypted keys, filled lazily per plane. Only resolved values are kept. */
	readonly keys: { language?: CachedKey; embedding?: CachedKey };
}
let configCache: ConfigCacheEntry | null = null;

function rowFingerprint(row: Doc<'aiProviderConfig'> | null): string {
	return row ? `${row._id}:${row.updatedAt}` : 'env';
}

/**
 * What a plane's decrypted key is bound to: the provider, its endpoint and the
 * exact envelope. Two saves in the same millisecond keep `updatedAt` (and so
 * the fingerprint), so a cached key is reused only while this still matches.
 */
function keyIdentity(row: Doc<'aiProviderConfig'>, plane: 'language' | 'embedding'): string {
	return plane === 'language'
		? JSON.stringify([
				row.languageProviderKind,
				row.languageBaseUrl ?? null,
				row.secretCiphertext ?? null,
				row.secretIv ?? null,
				row.secretAuthTag ?? null,
				row.secretEnvelopeVersion ?? null,
			])
		: JSON.stringify([
				row.embeddingProviderKind,
				row.embeddingSecretCiphertext ?? null,
				row.embeddingSecretIv ?? null,
				row.embeddingSecretAuthTag ?? null,
				row.embeddingSecretEnvelopeVersion ?? null,
			]);
}

/** The cached keys still bound to `row`; the others are decrypted again on demand. */
function keysStillValid(
	keys: ConfigCacheEntry['keys'],
	row: Doc<'aiProviderConfig'>
): ConfigCacheEntry['keys'] {
	const out: { language?: CachedKey; embedding?: CachedKey } = {};
	for (const plane of ['language', 'embedding'] as const) {
		const cached = keys[plane];
		if (cached && cached.identity === keyIdentity(row, plane)) out[plane] = cached;
	}
	return out;
}

/**
 * The cached row entry, re-reading the row once the recheck window has passed.
 * `isFresh` re-reads it on every call: the embedding plane needs that, because a
 * vector embedded with a config another isolate has already replaced lands in
 * the wrong space. A re-read always returns the row it read; decrypted keys
 * carry over only while the fingerprint and the key's own identity both match.
 */
export async function loadConfigEntry(
	ctx: ActionCtx,
	options: { isFresh?: boolean } = {}
): Promise<ConfigCacheEntry> {
	const cached = configCache;
	const now = Date.now();
	const live = cached !== null && cached.expiresAt > now;
	if (live && !options.isFresh && now - cached.checkedAt < AI_CONFIG_RECHECK_MS) return cached;
	const row = await ctx.runQuery(internal.aiProviderConfig._getConfigRow, {});
	const fingerprint = rowFingerprint(row);
	const isSameRow = live && cached.fingerprint === fingerprint && row !== null;
	const entry: ConfigCacheEntry = {
		row,
		fingerprint,
		expiresAt: isSameRow ? cached.expiresAt : now + AI_CONFIG_CACHE_TTL_MS,
		checkedAt: now,
		keys: isSameRow ? keysStillValid(cached.keys, row) : {},
	};
	configCache = entry;
	return entry;
}

/** A complete, decryptable AES-256-GCM envelope read off a config row. */
interface KeyEnvelope {
	ciphertext: string;
	iv: string;
	authTag: string;
	version: number;
}

/**
 * Assemble a `KeyEnvelope` from a row's four secret columns, or `undefined` when
 * any is absent (no key stored). Single-sources the read side across both planes,
 * mirroring how `storedEnvelopeOf` single-sources the persist side.
 */
function envelopeFromColumns(
	ciphertext: string | undefined,
	iv: string | undefined,
	authTag: string | undefined,
	version: number | undefined
): KeyEnvelope | undefined {
	if (
		ciphertext === undefined ||
		iv === undefined ||
		authTag === undefined ||
		version === undefined
	) {
		return undefined;
	}
	return { ciphertext, iv, authTag, version };
}

/** The language-key envelope of a row, or `undefined` when no key is stored. */
function languageKeyEnvelope(row: Doc<'aiProviderConfig'>): KeyEnvelope | undefined {
	return envelopeFromColumns(
		row.secretCiphertext,
		row.secretIv,
		row.secretAuthTag,
		row.secretEnvelopeVersion
	);
}

/** The embedding-key envelope of a row, or `undefined` when no key is stored. */
function embeddingKeyEnvelope(row: Doc<'aiProviderConfig'>): KeyEnvelope | undefined {
	return envelopeFromColumns(
		row.embeddingSecretCiphertext,
		row.embeddingSecretIv,
		row.embeddingSecretAuthTag,
		row.embeddingSecretEnvelopeVersion
	);
}

/**
 * One plane's decrypted key for a stored row, or `undefined` for a local /
 * keyless provider. Decrypts ONLY inside the Node action (this v8-safe module
 * never touches node:crypto) and only on the first ask per cache entry; the
 * plaintext builds a model and never reaches a query result or the client.
 */
export async function planeKey(
	ctx: ActionCtx,
	entry: ConfigCacheEntry,
	plane: 'language' | 'embedding'
): Promise<string | undefined> {
	const row = entry.row;
	if (!row) return undefined;
	const isLocal =
		plane === 'language'
			? languageProviderFor(row.languageProviderKind).isLocal
			: embeddingProviderFor(row.embeddingProviderKind).isLocal;
	if (isLocal) return undefined;
	const identity = keyIdentity(row, plane);
	const cached = entry.keys[plane];
	if (cached !== undefined && cached.identity === identity) return cached.key;
	const envelope = plane === 'language' ? languageKeyEnvelope(row) : embeddingKeyEnvelope(row);
	if (!envelope) return undefined;
	const key = await decryptEnvelope(ctx, envelope);
	entry.keys[plane] = { identity, key };
	return key;
}

/** Decrypt one envelope via the Node crypto action (the v8 resolver can't). */
function decryptEnvelope(ctx: ActionCtx, envelope: KeyEnvelope): Promise<string> {
	return ctx.runAction(internal.aiProviderConfigActions._decryptSecretEnvelope, envelope);
}

/**
 * Drop this isolate's cached config and keys. Called after a settings save so
 * the saving isolate sees the new provider at once; other isolates pick the
 * change up on their next row recheck.
 */
export function invalidateAiConfigCache(): void {
	configCache = null;
}
