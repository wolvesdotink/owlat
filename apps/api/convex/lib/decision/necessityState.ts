/**
 * The state the D5 necessity judgment is asked about (ADR-0073, Phase 3): the
 * same untrusted context the surface's slot extraction read (the Team
 * briefing, the Postbox transcript, Answer mode's context with the owner's
 * note), bounded head and tail like every decision state.
 *
 * It is never a sender-memory key: a necessity answer is about a reply, not a
 * label of the message, so the state is marked incomplete for memory.
 *
 * Pure and isolate-safe.
 */

import type { BuiltDecisionState } from './evidence';
import { capHeadTail, stateContentHash, STATE_MAX_CHARS } from './evidence';

/** The context's share of the state: the whole decision-state budget. */
export const NECESSITY_CONTEXT_CHARS = STATE_MAX_CHARS;

export function necessityState(context: string): BuiltDecisionState {
	const state = { thread: capHeadTail(context, NECESSITY_CONTEXT_CHARS).text };
	return { state, isComplete: false, contentFingerprint: stateContentHash(state) };
}
