/**
 * The measured half of an embedding space's identity (ADR-0073, Phase 1a; #1334).
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
 * A probe that cannot reach the server (network error, 5xx, timeout) throws, so
 * the caller treats it like the embedding call failing; it never falls back to
 * "unknown", which would silently register a second space.
 *
 * Runtime-neutral (global `fetch`), so the v8 retrieval seam can use it.
 */

import type { EmbeddingTarget } from '../embeddingSpace';
import type { EmbeddingSpaceIdentity } from './embeddingKeys';

/** How long a probe answer is reused. Short, so a pulled digest is seen quickly. */
const PROBE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 3_000;

interface ProbedRevision {
	readonly revision?: string;
	readonly quantization?: string;
}

const probeCache = new Map<string, { at: number; value: ProbedRevision }>();

/** Test-only: forget cached probe answers. */
export function __resetEmbeddingProbeCacheForTests(): void {
	probeCache.clear();
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

async function probeRevision(baseUrl: string, model: string): Promise<ProbedRevision> {
	const root = ollamaApiRoot(baseUrl);
	const cacheKey = `${root}|${model}`;
	const cached = probeCache.get(cacheKey);
	if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.value;

	let response: Response;
	try {
		response = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
	} catch (error) {
		throw new Error(`The embedding server at ${root} did not answer the revision probe.`, {
			cause: error,
		});
	}
	if (response.status >= 500) {
		throw new Error(`The embedding server at ${root} failed the revision probe.`);
	}
	let value: ProbedRevision = {};
	if (response.ok) {
		try {
			value = revisionFromOllamaTags(await response.json(), model);
		} catch {
			value = {};
		}
	}
	probeCache.set(cacheKey, { at: Date.now(), value });
	return value;
}

/**
 * The space a vector belongs to: the target the embedder resolved, the native
 * width of `rawEmbedding` (before index padding), and the local revision.
 */
export async function measuredEmbeddingSpace(
	target: EmbeddingTarget,
	rawEmbedding: ArrayLike<number>
): Promise<EmbeddingSpaceIdentity & { source: EmbeddingTarget['source'] }> {
	const probed = target.probeBaseUrl ? await probeRevision(target.probeBaseUrl, target.model) : {};
	return {
		provider: target.provider,
		endpoint: target.endpoint,
		model: target.model,
		dimensions: rawEmbedding.length,
		...probed,
		source: target.source,
	};
}
