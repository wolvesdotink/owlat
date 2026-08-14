/**
 * Collision soft-hold copy + result helpers (UX piece b3b).
 *
 * When a teammate is actively replying to the same shared-inbox thread, the
 * primary send/approve control renders HELD — disabled-styled but visible, with
 * a plain-language reason — instead of being hidden or locked. The hold releases
 * automatically when their `replying` presence expires (60s idle) or drops; it
 * is never a permanent block, never a modal, never an admin override.
 *
 * Belt-and-braces: `inbox.mutations.approveDraft` re-checks presence server-side
 * and returns `{ success: false, reason: 'reply_in_progress', heldByName }` when
 * a held button slipped through. {@link isReplyCollision} narrows that soft
 * error so callers show {@link replyCollisionToast} instead of a false success.
 */

/**
 * A message this module hands to a screen: an i18n key plus the values its
 * sentence interpolates. Nothing here calls `useI18n` (it is a pure module), so
 * the caller runs the pair through `t(key, params)`.
 */
export interface ReplyCollisionMessage {
	readonly key: string;
	readonly params?: Record<string, unknown>;
}

/**
 * Fallback name when a teammate's profile can't be resolved to a display name —
 * the i18n key of it, translated by the caller before it is interpolated.
 */
export const GENERIC_TEAMMATE_NAME = 'shared.replyCollision.genericTeammateName';

/**
 * The inline reason under a held button. Plain language, no jargon: it says WHY
 * it's held and that it takes over on its own — no action required.
 * e.g. "held while Jordan is editing — takes over automatically if they leave".
 */
export function sendHoldReason(name: string): ReplyCollisionMessage {
	return { key: 'shared.replyCollision.sendHoldReason', params: { name } };
}

/**
 * The toast when a send/approve is refused server-side because a teammate just
 * replied. e.g. "Jordan just sent a reply — review the thread".
 */
export function replyCollisionToast(name: string): ReplyCollisionMessage {
	return { key: 'shared.replyCollision.collisionToast', params: { name } };
}

/** The soft-error shape `approveDraft` returns when it refuses on a collision. */
export interface ReplyCollisionResult {
	success: false;
	reason: 'reply_in_progress';
	heldByName?: string;
}

/**
 * Narrow an approve/send mutation result to the collision soft-error. Callers
 * use this to branch to {@link replyCollisionToast} instead of claiming success
 * (the mutation resolves to a value in BOTH the success and collision cases, so
 * a plain `result !== undefined` check is not enough).
 */
export function isReplyCollision(result: unknown): result is ReplyCollisionResult {
	return (
		typeof result === 'object' &&
		result !== null &&
		(result as { success?: unknown }).success === false &&
		(result as { reason?: unknown }).reason === 'reply_in_progress'
	);
}
