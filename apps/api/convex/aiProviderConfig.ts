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
 *   Admin:    removeConfig — deletes the row, keys included, so resolution falls
 *                          back to the env `LLM_*` settings (or to no AI).
 *
 * Crypto + the plaintext-key path live in the sibling `'use node'` file
 * `aiProviderConfigActions.ts` (saveConfig / testConnection). Env `LLM_*`
 * remains the deployment fallback; a present row wins. Storage + surface only:
 * resolution lives elsewhere.
 *
 * THREE planes share this row: LANGUAGE, EMBEDDING and — since the 2026-09-17
 * decision-plane plan — DECISION. Each owns five secret columns (the AES-GCM
 * four plus a masked preview) written and cleared in lockstep. The decision
 * block is the only one that is optional end to end, because an install that
 * never opted into it must keep resolving exactly as it did before the plane
 * existed; a save that does not name a decision kind therefore CARRIES THOSE
 * COLUMNS FORWARD rather than patching them to `undefined`, which would clear
 * them.
 */

import { v } from 'convex/values';
import { internalQuery } from './_generated/server';
import { internalMutation } from './lib/writeFence';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { isEnvAiProviderConfigured } from './lib/aiNotConfigured';
import { adminMutation, authedQuery } from './lib/authedFunctions';
import { requireOrgPermission } from './lib/sessionOrganization';
import { recordAuditLog } from './lib/auditLog';
import { throwInvalidInput } from './_utils/errors';
import { validateOutboundUrl } from './lib/outboundUrlValidation';
import { envelopeValidator, resolvePlaneSecrets } from './lib/aiProviderSecrets';
import {
	configuredEmbeddingTarget,
	embeddingSelectionForSave,
	isLocalEmbeddingKind,
	isSameEmbeddingTarget,
	nextEmbeddingModelVersion,
	resolveStoredEmbeddingModel,
	storedEmbeddingTarget,
	throwEmbeddingKindRequired,
} from './lib/embeddingSpace';
import { endReembedJobs } from './lib/aiRouting/embeddingActivation';
import {
	decisionProviderKindValidator,
	embeddingProviderKindValidator,
	languageProviderKindValidator,
} from './lib/validators/aiProviderConfig';
import { decisionEnvProblem } from './lib/decisionEnvKind';

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
		// An invalid DECISION_PROVIDER refuses decisions; the card says why.
		const envProblem = decisionEnvProblem();
		const decisionEnv = envProblem ? { decisionEnvProblem: envProblem } : {};
		if (!row) return { configured: false as const, ...decisionEnv };
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
			resolvedEmbeddingModel: resolveStoredEmbeddingModel(row),
			embeddingModelVersion: row.embeddingModelVersion,
			isEmbeddingKeySet: row.embeddingSecretCiphertext !== undefined,
			embeddingKeyPreview: row.embeddingKeyPreview,
			// The DECISION plane, same rule: the selection, a masked preview and a
			// boolean. `decisionProviderKind` being absent is the ordinary state of
			// every install that never opted in, and the settings card reads it as
			// "not configured" rather than preselecting a vendor.
			decisionProviderKind: row.decisionProviderKind,
			decisionModel: row.decisionModel,
			decisionBaseUrl: row.decisionBaseUrl,
			isDecisionFallbackEnabled: row.isDecisionFallbackEnabled,
			isDecisionKeySet: row.decisionSecretCiphertext !== undefined,
			decisionKeyPreview: row.decisionKeyPreview,
			...decisionEnv,
			updatedAt: row.updatedAt,
		};
	},
});

// ── Internal write / raw-read path ─────────────────────────────────────────

/**
 * Admin-gated upsert of the org-singleton config. The calling Node action has
 * already encrypted any newly-entered key into `languageEnvelope` /
 * `embeddingEnvelope`; this mutation enforces the `organization:manage` floor,
 * preserves an unchanged key from disk, writes the row, and records the audit
 * log. An embedding switch is allowed (D8, post-provenance) and schedules the
 * re-embed kickoff.
 */
export const _persistConfig = internalMutation({
	args: {
		languageProviderKind: languageProviderKindValidator,
		languageBaseUrl: v.optional(v.string()),
		modelFast: v.string(),
		modelCapable: v.string(),
		isLanguageLocal: v.boolean(),
		languageEnvelope: v.optional(envelopeValidator),
		// Omitted ⇒ the current row's selection (resolved here, not in the action,
		// so a concurrent embedding save is never overwritten with a stale view).
		embeddingProviderKind: v.optional(embeddingProviderKindValidator),
		embeddingModel: v.optional(v.string()),
		/** Ignored: derived from the kind. A previous-release save still sends it; remove after release N+1. */
		isEmbeddingLocal: v.optional(v.boolean()),
		embeddingEnvelope: v.optional(envelopeValidator),
		// The DECISION plane. Omitting `decisionProviderKind` leaves the plane
		// untouched (see `lib/aiProviderSecrets`) — it is not a request to clear it.
		decisionProviderKind: v.optional(decisionProviderKindValidator),
		decisionModel: v.optional(v.string()),
		decisionBaseUrl: v.optional(v.string()),
		isDecisionFallbackEnabled: v.optional(v.boolean()),
		/** The chosen adapter carries no key of its own ⇒ clear all five columns. */
		isDecisionKeyless: v.optional(v.boolean()),
		/** The deployment supplies the key through its environment ⇒ none required here. */
		hasDecisionEnvKey: v.optional(v.boolean()),
		/** The chosen adapter runs on this server ⇒ its origin may be an internal http host. */
		isDecisionLocal: v.optional(v.boolean()),
		decisionEnvelope: v.optional(envelopeValidator),
	},
	handler: async (ctx, args): Promise<Id<'aiProviderConfig'>> => {
		const { userId } = await requireOrgPermission(ctx, 'organization:manage');

		// SSRF + key-exfiltration gate (persist time): a hosted provider carries a
		// decrypted key to `languageBaseUrl` at dispatch, so an admin-supplied URL
		// MUST be https and MUST NOT target a private/internal address. A LOCAL
		// (keyless) provider is allowed to point at http://localhost. DNS-time
		// enforcement is applied again at every fetch site (lib/ssrfGuard); this is
		// the write-time shape gate so a dangerous URL never lands in the row.
		if (args.languageBaseUrl !== undefined) {
			const check = validateOutboundUrl(args.languageBaseUrl, {
				requirePublic: !args.isLanguageLocal,
			});
			if (!check.ok) {
				throwInvalidInput(`Language provider base URL ${check.error}.`);
			}
		}

		// Same gate for the DECISION base URL. A hosted adapter's origin is one a
		// decrypted key will be sent to, so it must be public https; the local
		// engine carries no key and lives on the internal network by design. Both
		// flags must agree before the gate relaxes, so a save can never store a
		// key next to a private origin.
		if (args.decisionBaseUrl !== undefined) {
			const check = validateOutboundUrl(args.decisionBaseUrl, {
				requirePublic: !(args.isDecisionLocal === true && args.isDecisionKeyless === true),
			});
			if (!check.ok) {
				throwInvalidInput(`Decision provider base URL ${check.error}.`);
			}
		}

		const existing = await getSingleton(ctx);

		// A stored key stays only for the same provider kind and base URL (lib/aiProviderSecrets).
		// A new embedding key is bound to the kind the save names, never to the row's.
		if (args.embeddingEnvelope && args.embeddingProviderKind === undefined) {
			throwEmbeddingKindRequired();
		}
		const selection = embeddingSelectionForSave(
			{ kind: args.embeddingProviderKind, model: args.embeddingModel },
			existing
		);
		const { embeddingProviderKind, embeddingModel } = selection;
		const { language, embedding, decision } = resolvePlaneSecrets(
			{
				...args,
				embeddingProviderKind,
				isEmbeddingLocal: isLocalEmbeddingKind(embeddingProviderKind),
			},
			existing
		);

		// D8, post-provenance: a switch is allowed on a populated corpus. Vectors of
		// the old space drop out of vector search until they are re-embedded; the
		// version moves with the target.
		const embeddingModelVersion = nextEmbeddingModelVersion(existing, selection);
		const previousTarget = configuredEmbeddingTarget(existing);
		const isEmbeddingTargetChanged =
			!previousTarget || !isSameEmbeddingTarget(previousTarget, storedEmbeddingTarget(selection));

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
			embeddingProviderKind,
			embeddingModel,
			embeddingModelVersion,
			embeddingSecretCiphertext: embedding?.ciphertext,
			embeddingSecretIv: embedding?.iv,
			embeddingSecretAuthTag: embedding?.authTag,
			embeddingSecretEnvelopeVersion: embedding?.version,
			embeddingKeyPreview: embedding?.keyPreview,
			...decision,
			configRevision: (existing?.configRevision ?? 0) + 1,
			updatedAt: now,
		};

		let configId: Id<'aiProviderConfig'>;
		if (existing) {
			await ctx.db.patch(existing._id, fields);
			configId = existing._id;
		} else {
			configId = await ctx.db.insert('aiProviderConfig', fields);
			// The instance's first provider: files processed until now got no AI
			// metadata, and nothing else would ever run them again.
			if (!isEnvAiProviderConfigured()) {
				await ctx.scheduler.runAfter(0, internal.semanticFiles.reprocessAfterAiConfigured, {});
			}
		}

		// The new target's space activates with its first vector; a local embedder
		// is measured and re-embeds the corpus right away (aiRouting/embeddingReembed).
		if (isEmbeddingTargetChanged) {
			// Jobs embedding into the old space stop; the kickoff starts the new one's.
			await endReembedJobs(ctx);
			await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingReembed.kickoff, {
				isForced: true,
			});
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
				embeddingProviderKind,
				embeddingModel,
				embeddingModelVersion,
				isLanguageKeySet: language !== undefined,
				isEmbeddingKeySet: embedding !== undefined,
				decisionProviderKind: decision.decisionProviderKind,
				decisionModel: decision.decisionModel,
				isDecisionFallbackEnabled: decision.isDecisionFallbackEnabled,
				isDecisionKeySet: decision.decisionSecretCiphertext !== undefined,
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

/**
 * Delete the org-singleton config, stored keys included. Without a row every
 * plane resolves through the deployment's env `LLM_*` / `DECISION_*` settings,
 * or reports AI as not configured when those are unset. Running AI isolates
 * notice within their 30 s row recheck (`lib/llmProviders/storedConfigCache`),
 * whose fingerprint moves from the row to `'env'` and drops the cached keys.
 *
 * Nothing to delete is not an error: a second click, or a second admin who got
 * there first, ends in the same state.
 *
 * No semantic reprocessing is scheduled: files keep the metadata they already
 * have, and with the env fallback unset there is nothing to reprocess with.
 */
export const removeConfig = adminMutation({
	args: {},
	handler: async (ctx, _args, session): Promise<{ removed: boolean }> => {
		const existing = await getSingleton(ctx);
		if (!existing) return { removed: false };
		// D8, post-provenance: the vectors' spaces are recorded in `embeddingSpaces`,
		// so removal no longer loses them. The env fallback's target, if any, is a
		// switch like any other.
		await ctx.db.delete(existing._id);
		await endReembedJobs(ctx);
		await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingReembed.kickoff, {
			isForced: true,
		});

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'ai_provider_config.removed',
			resource: 'ai_provider_config',
			resourceId: existing._id,
			// Which planes held a key and which providers they named. Never the key,
			// its preview or the ciphertext.
			detailsBlob: JSON.stringify({
				languageProviderKind: existing.languageProviderKind,
				embeddingProviderKind: existing.embeddingProviderKind,
				decisionProviderKind: existing.decisionProviderKind,
				isLanguageKeySet: existing.secretCiphertext !== undefined,
				isEmbeddingKeySet: existing.embeddingSecretCiphertext !== undefined,
				isDecisionKeySet: existing.decisionSecretCiphertext !== undefined,
			}),
		});

		return { removed: true };
	},
});
