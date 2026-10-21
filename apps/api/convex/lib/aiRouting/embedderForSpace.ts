/**
 * An embedder for a space other than the configured one (the staged
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
import { meterLlmCall } from '../../analytics/meteredSpend';
import { runEmbedding } from '../llm/embed';
import type { LlmRootContext } from '../llm/requestMeter';
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
import { rethrowAdmissionRefusal } from '../llm/admissionPort';

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

/** Where the ledger records an embed-lane call: its feature, task and root. */
export interface EmbeddingSpend {
	readonly feature: 'embedding_knowledge' | 'embedding_file' | 'embedding_knowledge_search';
	readonly task: 'embedding.index' | 'embedding.query';
	readonly root: LlmRootContext;
}

/**
 * Embed texts for the index, bracketed by the revision probe: the served
 * revision is read before the first call and after the last, and the batch's
 * vectors are kept only when both reads agree (`measuredEmbeddingSpace`). A
 * single failed call leaves its slot null; a changed revision fails the whole
 * batch. `space` is the identity every kept vector is in.
 *
 * Every call is metered exactly once (`meterLlmCall` + `runEmbedding`, the
 * ledger's one path), under `spend.root` and the admission hold the batch runs
 * under (`counter.reservationId`), so a paid row names its reservation.
 */
export async function embedTextsForIndex(
	ctx: ActionCtx,
	embedder: IndexEmbedder,
	texts: readonly string[],
	spend: EmbeddingSpend,
	counter: DispatchCounter = { dispatched: 0, providerRequests: 0 }
): Promise<{ vectors: EmbeddedText[]; space: MeasuredSpace | null }> {
	const before = await probeEmbeddingRevision(embedder.target);
	const vectors: EmbeddedText[] = [];
	let width: number | null = null;
	for (const text of texts) {
		counter.dispatched += 1;
		try {
			const { embedding } = await meterLlmCall(
				ctx,
				{
					...spend,
					...(counter.reservationId ? { reservationId: counter.reservationId } : {}),
				},
				async (meter) => {
					try {
						return await runEmbedding({ meter, model: embedder.model, value: text });
					} finally {
						// Every request the call made, retries included (Sol r2 F5).
						counter.providerRequests += meter.requests.length;
					}
				},
				// A lost ledger row under-counts; failing the batch over it is worse.
				{ onWriteError: 'ignore' }
			);
			const raw = Array.from(embedding);
			if (width !== null && raw.length !== width) throw new Error('Inconsistent vector width.');
			width = raw.length;
			vectors.push({ vector: toIndexVector(raw), raw });
		} catch (error) {
			rethrowAdmissionRefusal(error); // a refused text is not a failed one (D1)
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
	ctx: ActionCtx,
	embedder: IndexEmbedder,
	text: string,
	spend: EmbeddingSpend,
	counter?: DispatchCounter
): Promise<{ vector: number[]; raw: number[]; space: MeasuredSpace }> {
	const { vectors, space } = await embedTextsForIndex(ctx, embedder, [text], spend, counter);
	const [embedded] = vectors;
	if (!embedded || !space) throw new Error('The embedding call failed.');
	return { ...embedded, space };
}
