/**
 * Pluggable AI providers (bring-your-own-key) — per-org config storage + read
 * surface. v8 (non-Node) half of the module.
 *
 * Holds the DB-facing functions for the `aiProviderConfig` org-singleton:
 *
 *   Public:   getConfig  — provider/model selections + a masked keyPreview + a
 *                          "configured" boolean. NEVER returns the encrypted
 *                          key envelope (ciphertext/iv/authTag) or plaintext.
 *   Internal: _persistConfig — admin-gated (`organization:manage`) upsert +
 *                          `recordAuditLog`. Called by the sibling `'use node'`
 *                          action after it has encrypted the plaintext key.
 *             _getConfigRow — the full row INCL. ciphertext, for the Node test
 *                          action to decrypt. Internal only.
 *
 * Crypto + the plaintext-key path live in the sibling `'use node'` file
 * `aiProviderConfigActions.ts` (saveConfig / testConnection). Env `LLM_*`
 * remains the deployment fallback; a present row wins (resolution is a later
 * plan piece — this piece is storage + surface only).
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { authedQuery } from './lib/authedFunctions';
import { requireOrgPermission } from './lib/sessionOrganization';
import { recordAuditLog } from './lib/auditLog';
import { throwInvalidInput } from './_utils/errors';
import {
	embeddingProviderKindValidator,
	languageProviderKindValidator,
} from './lib/aiProviderConfigValidators';

/** The org-singleton config row, or null. Single-org-per-deployment ⇒ `first()`. */
async function getSingleton(ctx: QueryCtx | MutationCtx): Promise<Doc<'aiProviderConfig'> | null> {
	return await ctx.db.query('aiProviderConfig').first(); // bounded: org-singleton (≤ 1 row)
}

// ── Public read surface (member-readable; no secrets) ──────────────────────

/**
 * The org's AI-provider config, or `{ configured: false }`. Returns only the
 * provider/model selections, a masked `keyPreview`, and `is*KeySet` booleans —
 * NEVER the encrypted envelope or the plaintext key.
 */
// all-members: read-only provider/model selections + masked previews only (no
// secret ever leaves the backend), so any org member may read the config.
export const getConfig = authedQuery({
	args: {},
	handler: async (ctx) => {
		const row = await getSingleton(ctx);
		if (!row) return { configured: false as const };
		return {
			configured: true as const,
			languageProviderKind: row.languageProviderKind,
			languageBaseUrl: row.languageBaseUrl,
			modelFast: row.modelFast,
			modelCapable: row.modelCapable,
			isLanguageKeySet: row.secretCiphertext !== undefined,
			keyPreview: row.keyPreview,
			embeddingProviderKind: row.embeddingProviderKind,
			embeddingModel: row.embeddingModel,
			embeddingModelVersion: row.embeddingModelVersion,
			isEmbeddingKeySet: row.embeddingSecretCiphertext !== undefined,
			embeddingKeyPreview: row.embeddingKeyPreview,
			updatedAt: row.updatedAt,
		};
	},
});

// ── Internal write / raw-read path ─────────────────────────────────────────

/** A freshly-encrypted key envelope handed over by the Node save action. */
const envelopeValidator = v.object({
	ciphertext: v.string(),
	iv: v.string(),
	authTag: v.string(),
	version: v.number(),
	keyPreview: v.string(),
});

type Envelope = {
	ciphertext: string;
	iv: string;
	authTag: string;
	version: number;
	keyPreview: string;
};

/** A possibly-incomplete envelope read back off an existing row. */
interface StoredEnvelope {
	ciphertext?: string;
	iv?: string;
	authTag?: string;
	version?: number;
	keyPreview?: string;
}

/**
 * Map the stored envelope columns of one plane off an existing config row. The
 * language and embedding planes use identically-shaped column sets that differ
 * only by the `embedding` prefix, so this single mapper feeds both
 * `resolveSecret({ existing })` call sites. Returns `undefined` when there is no
 * row yet.
 */
function storedEnvelopeOf(
	row: Doc<'aiProviderConfig'> | null,
	plane: 'language' | 'embedding'
): StoredEnvelope | undefined {
	if (!row) return undefined;
	return plane === 'language'
		? {
				ciphertext: row.secretCiphertext,
				iv: row.secretIv,
				authTag: row.secretAuthTag,
				version: row.secretEnvelopeVersion,
				keyPreview: row.keyPreview,
			}
		: {
				ciphertext: row.embeddingSecretCiphertext,
				iv: row.embeddingSecretIv,
				authTag: row.embeddingSecretAuthTag,
				version: row.embeddingSecretEnvelopeVersion,
				keyPreview: row.embeddingKeyPreview,
			};
}

/**
 * Decide the final stored key envelope for one plane. A freshly-entered key
 * wins; otherwise the stored envelope is kept (secrets never round-trip through
 * the client, so an unchanged key is re-persisted from disk). A local, keyless
 * provider clears any stored key. A hosted provider with neither a new nor a
 * stored key is rejected — we never persist a hosted config that can't run.
 */
function resolveSecret(input: {
	isLocal: boolean;
	envelope?: Envelope;
	existing?: StoredEnvelope;
	label: string;
}): Envelope | undefined {
	if (input.isLocal) return undefined;
	if (input.envelope) return input.envelope;
	const e = input.existing;
	if (
		e &&
		e.ciphertext !== undefined &&
		e.iv !== undefined &&
		e.authTag !== undefined &&
		e.version !== undefined &&
		e.keyPreview !== undefined
	) {
		return {
			ciphertext: e.ciphertext,
			iv: e.iv,
			authTag: e.authTag,
			version: e.version,
			keyPreview: e.keyPreview,
		};
	}
	throwInvalidInput(`The ${input.label} provider requires an API key.`);
}

/**
 * Admin-gated upsert of the org-singleton config. The calling Node action has
 * already encrypted any newly-entered key into `languageEnvelope` /
 * `embeddingEnvelope`; this mutation enforces the `organization:manage` floor,
 * preserves an unchanged key from disk, bumps the embedding dimension guard on
 * a model/provider change, writes the row, and records the audit log.
 */
export const _persistConfig = internalMutation({
	args: {
		languageProviderKind: languageProviderKindValidator,
		languageBaseUrl: v.optional(v.string()),
		modelFast: v.string(),
		modelCapable: v.string(),
		isLanguageLocal: v.boolean(),
		languageEnvelope: v.optional(envelopeValidator),
		embeddingProviderKind: embeddingProviderKindValidator,
		embeddingModel: v.optional(v.string()),
		isEmbeddingLocal: v.boolean(),
		embeddingEnvelope: v.optional(envelopeValidator),
	},
	handler: async (ctx, args): Promise<Id<'aiProviderConfig'>> => {
		const { userId } = await requireOrgPermission(ctx, 'organization:manage');
		const existing = await getSingleton(ctx);

		const language = resolveSecret({
			isLocal: args.isLanguageLocal,
			envelope: args.languageEnvelope,
			existing: storedEnvelopeOf(existing, 'language'),
			label: 'language',
		});
		const embedding = resolveSecret({
			isLocal: args.isEmbeddingLocal,
			envelope: args.embeddingEnvelope,
			existing: storedEnvelopeOf(existing, 'embedding'),
			label: 'embedding',
		});

		// Dimension guard: bump the version whenever the embedding model/provider
		// changes so stale vectors are never silently mixed with new-model ones.
		const embeddingChanged =
			!existing ||
			existing.embeddingProviderKind !== args.embeddingProviderKind ||
			existing.embeddingModel !== args.embeddingModel;
		const embeddingModelVersion = existing
			? existing.embeddingModelVersion + (embeddingChanged ? 1 : 0)
			: 1;

		const now = Date.now();
		// `undefined` on a patch column clears it — this is what drops a stored key
		// when the provider switches to a local (keyless) backend.
		const fields = {
			languageProviderKind: args.languageProviderKind,
			languageBaseUrl: args.languageBaseUrl,
			modelFast: args.modelFast,
			modelCapable: args.modelCapable,
			secretCiphertext: language?.ciphertext,
			secretIv: language?.iv,
			secretAuthTag: language?.authTag,
			secretEnvelopeVersion: language?.version,
			keyPreview: language?.keyPreview,
			embeddingProviderKind: args.embeddingProviderKind,
			embeddingModel: args.embeddingModel,
			embeddingModelVersion,
			embeddingSecretCiphertext: embedding?.ciphertext,
			embeddingSecretIv: embedding?.iv,
			embeddingSecretAuthTag: embedding?.authTag,
			embeddingSecretEnvelopeVersion: embedding?.version,
			embeddingKeyPreview: embedding?.keyPreview,
			updatedAt: now,
		};

		let configId: Id<'aiProviderConfig'>;
		if (existing) {
			await ctx.db.patch(existing._id, fields);
			configId = existing._id;
		} else {
			configId = await ctx.db.insert('aiProviderConfig', fields);
		}

		await recordAuditLog(ctx, {
			userId,
			action: 'ai_provider_config.updated',
			resource: 'ai_provider_config',
			resourceId: configId,
			// Non-secret summary only — never the key or ciphertext.
			detailsBlob: JSON.stringify({
				languageProviderKind: args.languageProviderKind,
				modelFast: args.modelFast,
				modelCapable: args.modelCapable,
				embeddingProviderKind: args.embeddingProviderKind,
				embeddingModel: args.embeddingModel,
				embeddingModelVersion,
				isLanguageKeySet: language !== undefined,
				isEmbeddingKeySet: embedding !== undefined,
			}),
		});

		return configId;
	},
});

/**
 * Full row INCL. the encrypted envelope — internal only, for the Node
 * `testConnection` action to decrypt. Never exposed publicly.
 */
export const _getConfigRow = internalQuery({
	args: {},
	handler: async (ctx) => await getSingleton(ctx),
});
