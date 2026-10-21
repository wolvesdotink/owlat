/**
 * Output that stopped at its ceiling. Every dispatch now sends an
 * output ceiling, so a reply can end because it hit the limit rather than
 * because the model was done: the provider reports `finishReason: 'length'`
 * (Anthropic's `max_tokens` stop). The dispatch surfaces it as `isTruncated`
 * on its result; a caller that would store or show the text as finished (a
 * draft, a revision, a rewrite) treats it as INCOMPLETE and takes its failure
 * path instead. Pure.
 */

/** True when the provider stopped because the output ceiling was reached. */
export function isLengthStop(finishReason: string | undefined): boolean {
	return finishReason === 'length';
}

/** A generation that stopped at its output ceiling: incomplete, never a finished result. */
export class LlmTruncatedError extends Error {
	override readonly name = 'LlmTruncatedError';

	constructor(what: string) {
		super(`The ${what} stopped at its output limit and is incomplete.`);
	}
}
