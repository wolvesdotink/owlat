/**
 * A fresh handle for one `→ pending_send` / `→ scheduled` hold. The scheduled
 * dispatch and the undo both name the hold by it, so a dispatch scheduled for
 * an earlier hold of the same draft finds a different token and stands down
 * (`mail/outbound.ts`). Minted by the dispatcher in `./effects.ts` and handed
 * to the reducers, which are pure and cannot hold a random source.
 */
export function generateUndoToken(at: number): string {
	return `und_${at.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
