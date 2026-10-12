/**
 * An embedder for a space other than the configured one (ADR-0073, Phase 5
 * rebuild and the re-embed job).
 *
 * A staged rebuild embeds with the target space's model while retrieval keeps
 * the configured one. Building that second embedder needs no new secret in two
 * cases, and only those are supported:
 *
 *   - a local kind (`local`, `openaiCompatible`), served at
 *     `LOCAL_EMBEDDING_BASE_URL` (its origin must be the space's endpoint);
 *   - the stored hosted kind with another model (a model change at the same
 *     provider), reusing the stored key.
 *
 * Any other target (another hosted provider, an env-configured endpoint) is
 * reached through the settings instead: a saved switch is the D8 path.
 */

import type { ActionCtx } from '../../_generated/server';
import { embed } from 'ai';
import { AiNotConfiguredError } from '../aiNotConfigured';
import {
	isLocalEmbeddingKind,
	storedEmbeddingTarget,
	type StoredEmbeddingSelection,
} from '../embeddingSpace';
import {
	buildIndexEmbedder,
	resolveEmbeddingPlane,
	resolveIndexEmbedder,
	toIndexVector,
	type IndexEmbedder,
} from '../llmProvider';
import { loadConfigEntry, planeKey } from '../llmProviders/storedConfigCache';
import { measuredEmbeddingSpace } from './embeddingProbe';
import {
	identityOf,
	isIdentityOfTarget,
	type MeasuredSpace,
	type SpaceDoc,
} from './embeddingRegistry';

/** The configured embedder, or null when no AI is set up. */
export async function configuredEmbedderOrNull(ctx: ActionCtx): Promise<IndexEmbedder | null> {
	try {
		return await resolveIndexEmbedder(ctx);
	} catch (error) {
		if (error instanceof AiNotConfiguredError) return null;
		throw error;
	}
}

/**
 * An embedder for a stored selection (kind + model) without saving it: local
 * kinds always, a hosted kind only when it is the stored one (its key). Null
 * when the selection needs a key Owlat does not hold.
 */
export async function resolveEmbedderForSelection(
	ctx: ActionCtx,
	selection: StoredEmbeddingSelection
): Promise<IndexEmbedder | null> {
	const kind = selection.embeddingProviderKind;
	const target = storedEmbeddingTarget(selection);
	if (isLocalEmbeddingKind(kind)) {
		return buildIndexEmbedder(
			resolveEmbeddingPlane(kind, target.model, undefined, undefined),
			target
		);
	}
	const entry = await loadConfigEntry(ctx, { isFresh: true });
	if (!entry.row || entry.row.embeddingProviderKind !== kind) return null;
	const key = await planeKey(ctx, entry, 'embedding');
	if (!key) return null;
	return buildIndexEmbedder(resolveEmbeddingPlane(kind, target.model, key, undefined), target);
}

/** An embedder whose target is `space`'s, or null when none can be built. */
export async function resolveEmbedderForSpace(
	ctx: ActionCtx,
	space: SpaceDoc
): Promise<IndexEmbedder | null> {
	const identity = identityOf(space);
	const configured = await configuredEmbedderOrNull(ctx);
	if (configured && isIdentityOfTarget(identity, configured.target)) return configured;
	if (space.source === 'env') return null;
	const embedder = await resolveEmbedderForSelection(ctx, {
		embeddingProviderKind: space.provider,
		embeddingModel: space.model,
	});
	return embedder && isIdentityOfTarget(identity, embedder.target) ? embedder : null;
}

/**
 * Embed one text for the index: the padded vector and the space it is in.
 * The ledger lane meters this call (task `embedding.index`) where it wires
 * `runEmbedding`; it is the only embedding call the embed lane's jobs make.
 */
export async function embedForIndex(
	embedder: IndexEmbedder,
	text: string
): Promise<{ vector: number[]; raw: number[]; space: MeasuredSpace }> {
	const { embedding } = await embed({ model: embedder.model, value: text });
	return {
		vector: toIndexVector(embedding),
		raw: Array.from(embedding),
		space: await measuredEmbeddingSpace(embedder.target, embedding),
	};
}
