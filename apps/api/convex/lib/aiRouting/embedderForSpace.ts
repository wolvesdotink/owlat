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
import type { DispatchCounter } from './embeddingDispatch';
import {
	EmbeddingRevisionChangedError,
	measuredEmbeddingSpace,
	probeEmbeddingRevision,
} from './embeddingProbe';
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

/** One text's padded vector and raw vector, or null when its call failed. */
export type EmbeddedText = { vector: number[]; raw: number[] } | null;

/**
 * Embed texts for the index, bracketed by the revision probe: the served
 * revision is read before the first call and after the last, and the batch's
 * vectors are kept only when both reads agree (`measuredEmbeddingSpace`). A
 * single failed call leaves its slot null; a changed revision fails the whole
 * batch. `space` is the identity every kept vector is in.
 *
 * The ledger lane meters these calls (task `embedding.index`) where it wires
 * `runEmbedding`; they are the only embedding calls the embed lane's jobs make.
 */
export async function embedTextsForIndex(
	embedder: IndexEmbedder,
	texts: readonly string[],
	counter: DispatchCounter = { dispatched: 0 }
): Promise<{ vectors: EmbeddedText[]; space: MeasuredSpace | null }> {
	const before = await probeEmbeddingRevision(embedder.target);
	const vectors: EmbeddedText[] = [];
	let width: number | null = null;
	for (const text of texts) {
		counter.dispatched += 1;
		try {
			const { embedding } = await embed({ model: embedder.model, value: text });
			const raw = Array.from(embedding);
			if (width !== null && raw.length !== width) throw new Error('Inconsistent vector width.');
			width = raw.length;
			vectors.push({ vector: toIndexVector(raw), raw });
		} catch {
			vectors.push(null);
		}
	}
	if (width === null) return { vectors, space: null };
	try {
		const space = await measuredEmbeddingSpace(embedder.target, { length: width }, before);
		return { vectors, space };
	} catch (error) {
		if (error instanceof EmbeddingRevisionChangedError) {
			return { vectors: vectors.map(() => null), space: null };
		}
		throw error;
	}
}

/** Embed one text for the index; throws when the call fails or the model changed. */
export async function embedForIndex(
	embedder: IndexEmbedder,
	text: string,
	counter?: DispatchCounter
): Promise<{ vector: number[]; raw: number[]; space: MeasuredSpace }> {
	const { vectors, space } = await embedTextsForIndex(embedder, [text], counter);
	const [embedded] = vectors;
	if (!embedded || !space) throw new Error('The embedding call failed.');
	return { ...embedded, space };
}
