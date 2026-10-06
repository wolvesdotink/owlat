/**
 * The markup gate of the shared draft service (agent/shared/draftService.ts),
 * split out to keep that file under the size cap. Pure apart from the
 * callbacks it is given (no ctx, no 'use node').
 */

import type { LlmTextResult } from '../../lib/llm/dispatch';
import { stripLeakedToolMarkup } from '../../lib/llm/toolMarkup';
import { addTokenUsage } from '../../lib/llm/tokenUsage';
import { logWarn } from '../../lib/runtimeLog';

export type PrimaryDraft = Readonly<{
	draftBody: string;
	tokenUsage: LlmTextResult['tokenUsage'];
	modelUsed: LlmTextResult['modelUsed'];
}>;

/**
 * The primary draft without tool-call markup the model typed into it (#1254,
 * lib/llm/toolMarkup.ts). A leading markup prefix is cut. A draft with markup
 * after the reply started, cut inside a tag, or with nothing after the prefix,
 * is generated once more without tools, by a prompt that names none, since
 * that is what invites a typed-out call. When that one is unusable as well, or
 * fails, the generation throws: every caller already treats a throw as "no
 * draft" (Reply Queue, Postbox) or as a failed step that a person picks up
 * (Team Inbox). Before it throws, the attempts already paid for are recorded
 * through `recordRejected`, because the throw carries no usage back. Markup
 * is never kept.
 */
export async function withoutToolMarkup(
	primary: PrimaryDraft,
	retryWithoutTools: () => Promise<LlmTextResult>,
	recordRejected: (attempts: ReadonlyArray<Omit<PrimaryDraft, 'draftBody'>>) => Promise<void>
): Promise<PrimaryDraft> {
	const first = stripLeakedToolMarkup(primary.draftBody);
	if (first.kind !== 'unusable') return { ...primary, draftBody: first.text };
	logWarn('[sharedDraft] draft was tool-call markup; retrying without tools:', first.reason);
	let retry: LlmTextResult;
	try {
		retry = await retryWithoutTools();
	} catch (error) {
		await recordRejected([primary]);
		throw error;
	}
	const second = stripLeakedToolMarkup(retry.text);
	if (second.kind === 'unusable') {
		await recordRejected([primary, retry]);
		throw new Error(`Draft generation returned tool-call markup (${second.reason}).`);
	}
	return {
		draftBody: second.text,
		tokenUsage: addTokenUsage(primary.tokenUsage, retry.tokenUsage),
		modelUsed: retry.modelUsed ?? primary.modelUsed,
	};
}
