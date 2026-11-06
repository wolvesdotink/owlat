/**
 * Whether the language provider is refusing the instance's key.
 *
 * A refused key fails every AI call the same way, so it is the instance's
 * state, not something that happened in one thread: the thread brief records
 * it as a gate refusal and shows a quiet note, and this record is what tells
 * an admin, once, in AI settings and the app shell. It holds only when the
 * refusal was first and last seen, never the provider's message (which can
 * quote part of the key).
 *
 * Leaf module. It lives on the `aiProvider` row of `instanceCounters`, so its writes re-run
 * only the admin notice, not every feature gate. While the key stays refused
 * the last-seen time is re-stamped at most every {@link RESTAMP_MS}. The record
 * goes away when a call is accepted again or an admin saves or removes the AI
 * settings.
 */

import type { DatabaseReader, MutationCtx } from '../_generated/server';
import { readInstanceCounter, writeInstanceCounter } from './instanceCounters';

/** How stale the stored last-seen time may get while the key stays refused. */
export const RESTAMP_MS = 10 * 60_000;

/** The open refusal, if the provider is refusing the key. */
export async function readProviderAuthFailure(
	db: DatabaseReader
): Promise<{ firstSeenAt: number; lastSeenAt: number } | null> {
	const { aiProviderAuthFailure } = await readInstanceCounter(db, 'aiProvider');
	return aiProviderAuthFailure ?? null;
}

/** Record that the provider refused the key at `now`. */
export async function recordProviderAuthFailure(ctx: MutationCtx, now: number): Promise<void> {
	const open = await readProviderAuthFailure(ctx.db);
	if (open && now - open.lastSeenAt < RESTAMP_MS) return;
	await writeInstanceCounter(
		ctx,
		'aiProvider',
		{ aiProviderAuthFailure: { firstSeenAt: open?.firstSeenAt ?? now, lastSeenAt: now } },
		now
	);
}

/** Close the open refusal, if there is one: a call was accepted, or the key changed. */
export async function clearProviderAuthFailure(ctx: MutationCtx): Promise<void> {
	if (!(await readProviderAuthFailure(ctx.db))) return;
	await writeInstanceCounter(ctx, 'aiProvider', { aiProviderAuthFailure: undefined });
}
