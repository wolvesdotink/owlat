/**
 * The measured half of an embedding space's identity (#1334).
 *
 * The configuration names a target (`lib/embeddingSpace.ts`): provider,
 * endpoint, model, requested width. Two facts only the provider knows complete
 * it into a space:
 *
 *   - the native width, read from the vector a call returned (`toIndexVector`
 *     pads it to the index width afterwards, so the caller passes the raw one);
 *   - for a local model, the artifact revision. `nomic-embed-text` is an
 *     unversioned alias that resolves to `latest`, so an `ollama pull` can swap
 *     the weights under the same name. Ollama reports the digest and the
 *     quantization of every pulled model at `GET /api/tags` (`/api/show` carries
 *     the quantization but no digest). A server that does not answer that
 *     endpoint (vLLM, llama.cpp, a custom server) leaves the revision unknown,
 *     which is part of the identity: unknown is never treated as a match for a
 *     known digest.
 *
 * The probe is never cached, and it brackets the call: the revision is read
 * before the embedding and again after it, and a vector is stamped only when
 * both reads agree. A model replaced while the call ran (`ollama pull`) changes
 * the digest between the two reads, and the vector is discarded rather than
 * stamped with either revision. (A replacement and its exact undo inside one
 * call would pass; the digest cannot tell those apart.)
 *
 * A probe that cannot reach the server (network error, 5xx, timeout) throws, so
 * the caller treats it like the embedding call failing; it never falls back to
 * "unknown", which would silently register a second space.
 *
 * Runtime-neutral (global `fetch`), so the v8 retrieval seam can use it.
 */

import { endpointIdentity, type EmbeddingTarget } from '../embeddingSpace';
import type { EmbeddingSpaceIdentity } from './embeddingKeys';

const PROBE_TIMEOUT_MS = 3_000;

/** The revision a local server reports for a model; both absent when it reports none. */
export interface ProbedRevision {
	readonly revision?: string;
	readonly quantization?: string;
}

/** Thrown when the served model changed while an embedding call ran. */
export class EmbeddingRevisionChangedError extends Error {
	constructor() {
		super('The embedding model was replaced while the call ran; the vector was discarded.');
		this.name = 'EmbeddingRevisionChangedError';
	}
}

/** The server root of an OpenAI-compatible base URL (`…/v1` stripped). */
export function ollamaApiRoot(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** The tagged name Ollama lists for a model id (`name` → `name:latest`). */
function taggedName(model: string): string {
	return model.includes(':') ? model : `${model}:latest`;
}

interface OllamaTagEntry {
	name?: unknown;
	model?: unknown;
	digest?: unknown;
	details?: { quantization_level?: unknown };
}

/** Pure: the revision Ollama's `/api/tags` body reports for `model`. */
export function revisionFromOllamaTags(body: unknown, model: string): ProbedRevision {
	const models = (body as { models?: unknown } | null)?.models;
	if (!Array.isArray(models)) return {};
	const wanted = new Set([model, taggedName(model)]);
	const entry = (models as OllamaTagEntry[]).find(
		(m) =>
			(typeof m?.name === 'string' && wanted.has(m.name)) ||
			(typeof m?.model === 'string' && wanted.has(m.model))
	);
	if (!entry) return {};
	const digest = typeof entry.digest === 'string' && entry.digest ? entry.digest : undefined;
	const quantization = entry.details?.quantization_level;
	return {
		...(digest ? { revision: digest } : {}),
		...(typeof quantization === 'string' && quantization ? { quantization } : {}),
	};
}

/**
 * The probe's errors name the server by its endpoint identity, never by the
 * base URL (whose userinfo, path or query may hold a credential), and carry no
 * `cause`: fetch errors quote the request URL.
 */
async function fetchRevision(baseUrl: string, model: string): Promise<ProbedRevision> {
	const root = ollamaApiRoot(baseUrl);
	const server = endpointIdentity(root);
	// The rejection becomes a value, so the thrown error deliberately has no cause.
	const answer = await fetch(`${root}/api/tags`, {
		signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
	}).then(
		(response) => ({ response }),
		(error: unknown) => ({ failure: error instanceof Error ? error.name : 'Error' })
	);
	if ('failure' in answer) {
		throw new Error(
			`The embedding server ${server} did not answer the revision probe (${answer.failure}).`
		);
	}
	const { response } = answer;
	if (response.status >= 500) {
		throw new Error(`The embedding server ${server} failed the revision probe.`);
	}
	if (!response.ok) return {};
	try {
		return revisionFromOllamaTags(await response.json(), model);
	} catch {
		return {};
	}
}

/**
 * The target's current revision, read now (never cached). Call it right before
 * an embedding call and pass the answer to {@link measuredEmbeddingSpace}.
 * Hosted targets have none and make no request.
 */
export async function probeEmbeddingRevision(target: EmbeddingTarget): Promise<ProbedRevision> {
	return target.probeBaseUrl ? fetchRevision(target.probeBaseUrl, target.model) : {};
}

function isSameRevision(a: ProbedRevision, b: ProbedRevision): boolean {
	return a.revision === b.revision && a.quantization === b.quantization;
}

/**
 * The space a vector belongs to: the target the embedder resolved, the native
 * width of `rawEmbedding` (before index padding), and the local revision. The
 * revision is read again now and must equal `before` (read before the call), or
 * the vector is discarded ({@link EmbeddingRevisionChangedError}).
 */
export async function measuredEmbeddingSpace(
	target: EmbeddingTarget,
	rawEmbedding: ArrayLike<number>,
	before: ProbedRevision
): Promise<EmbeddingSpaceIdentity & { source: EmbeddingTarget['source'] }> {
	const after = await probeEmbeddingRevision(target);
	if (!isSameRevision(before, after)) throw new EmbeddingRevisionChangedError();
	return {
		provider: target.provider,
		endpoint: target.endpoint,
		model: target.model,
		dimensions: rawEmbedding.length,
		...after,
		source: target.source,
	};
}
