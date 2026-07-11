/**
 * Shared parser for an OpenAI-shaped `/models` listing.
 *
 * OpenRouter's `/api/v1/models` and any OpenAI-compatible server's `/models`
 * (Ollama, vLLM, llama.cpp) return the same envelope: `{ data: [{ id, … }] }`.
 * Both the `openrouter` and `openaiCompatible` adapters populate the settings
 * model-picker from that shape, so the extraction lives here once. Pure and
 * isolate-safe (no `'use node'`).
 *
 * Parsing is DEFENSIVE: anything off-shape (a missing/ non-string id, a
 * non-array `data`, a null body) is skipped rather than throwing, so one
 * malformed entry — or a whole malformed body — can't sink the listing.
 */

/**
 * Extract the model ids from an OpenAI-shaped `/models` payload
 * (`{ data: [{ id, … }] }`). Returns an empty list for anything off-shape.
 */
export function parseOpenAiModelIds(body: unknown): string[] {
	if (typeof body !== 'object' || body === null || !('data' in body)) {
		return [];
	}
	const data = (body as { data: unknown }).data;
	if (!Array.isArray(data)) {
		return [];
	}
	const ids: string[] = [];
	for (const entry of data) {
		if (typeof entry === 'object' && entry !== null && 'id' in entry) {
			const id = (entry as { id: unknown }).id;
			if (typeof id === 'string' && id.length > 0) {
				ids.push(id);
			}
		}
	}
	return ids;
}
