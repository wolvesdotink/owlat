/**
 * Pure keyboard-dispatch resolvers for the focused task-flows (personal Reply
 * Queue and team Review Queue). Each flow binds a `keydown` listener that owns
 * the ambient card vocabulary — approve/reject/reply/archive on the card in
 * focus. Those shortcuts are only ever meant for the BUILT-IN cards a flow
 * renders natively; a plugin- or unknown-kind card is drawn by TaskCardRenderer
 * (its own visible controls, or the graceful fallback placeholder) and MUST NOT
 * inherit the native vocabulary — otherwise pressing Enter over the placeholder
 * would invisibly approve-and-send, reject, or archive the underlying item, an
 * action the visible card never offers.
 *
 * So the resolvers gate on the current card's kind:
 *   - a built-in kind → the flow's native vocabulary (unchanged);
 *   - a non-native kind (plugin/unknown) → only the shared `s` → skip
 *     affordance the fallback advertises, so a stuck user can always advance.
 *
 * Returning `null` means "do nothing" (the handler leaves the event alone —
 * no preventDefault). Extracted here so the gate is unit-testable without
 * mounting the Convex-backed flow components.
 */

import { isBuiltInTaskFlowKind } from './taskCardRegistry';
import type { TaskFlowKind } from './taskFlow';

/** Actions the Review Queue's focused card keyboard can invoke. */
export type ReviewFocusKeyAction = 'approve' | 'reject' | 'sendReply' | 'skip';

/**
 * Resolve a keypress to a Review Queue focused-card action, or `null` for none.
 * Built-in vocabulary: `x` rejects, `a` approves a draft (not a needs-reply
 * escalation), `Enter` sends the reply for an escalation else approves. A
 * non-native card only honours `s` → skip.
 */
export function resolveReviewFocusKey(
	rawKey: string,
	ctx: { currentKind: TaskFlowKind | null; needsReply: boolean }
): ReviewFocusKeyAction | null {
	const { currentKind } = ctx;
	if (!currentKind) return null;
	const key = rawKey.toLowerCase();
	if (!isBuiltInTaskFlowKind(currentKind)) {
		return key === 's' ? 'skip' : null;
	}
	if (key === 'x') return 'reject';
	if (key === 'a' && !ctx.needsReply) return 'approve';
	if (key === 'enter') return ctx.needsReply ? 'sendReply' : 'approve';
	return null;
}

/** Actions the Reply Queue's focused card keyboard can invoke. */
export type ReplyFocusKeyAction = 'markDone' | 'draftReply' | 'archive' | 'skip';

/**
 * Resolve a keypress to a Reply Queue focused-card action, or `null` for none.
 * Built-in vocabulary: `Enter` marks a follow-up done else drafts a reply, `e`
 * archives a non-follow-up row. A non-native card only honours `s` → skip.
 */
export function resolveReplyFocusKey(
	rawKey: string,
	ctx: { currentKind: TaskFlowKind | null; isFollowup: boolean }
): ReplyFocusKeyAction | null {
	const { currentKind } = ctx;
	if (!currentKind) return null;
	const key = rawKey.toLowerCase();
	if (!isBuiltInTaskFlowKind(currentKind)) {
		return key === 's' ? 'skip' : null;
	}
	if (key === 'enter') return ctx.isFollowup ? 'markDone' : 'draftReply';
	if (key === 'e' && !ctx.isFollowup) return 'archive';
	return null;
}
