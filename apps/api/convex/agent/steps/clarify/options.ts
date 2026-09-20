/**
 * Bounding of the slot extractor's suggested answers for the `clarify` step —
 * split out of ./index.ts to keep it under the ~500 LOC file-size ratchet.
 */

import { isCredentialSolicitation } from '../../../inbox/clarificationSlots';

const MAX_OPTION_CHARS = 80;
const MAX_OPTIONS = 4;

/**
 * The slot extractor's suggested answers, bounded for the chip row. These are
 * the "how could I answer this" suggestions the person sees beside the free
 * text box. Credential-shaped options never survive (the question text itself
 * is filtered by the same rule in the Postbox path; here the slot prompt
 * cannot ask for one, but the model can still be steered by the mail).
 */
export function boundedOptions(raw: readonly string[] | undefined): string[] | undefined {
	if (!raw) return undefined;
	const out: string[] = [];
	for (const option of raw) {
		const trimmed = option.trim().slice(0, MAX_OPTION_CHARS);
		if (trimmed.length === 0 || isCredentialSolicitation(trimmed)) continue;
		if (out.includes(trimmed)) continue;
		out.push(trimmed);
		if (out.length >= MAX_OPTIONS) break;
	}
	return out.length > 0 ? out : undefined;
}
