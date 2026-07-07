/**
 * Message Coalescing
 *
 * Debounce for rapid-fire inbound messages on the same thread. Email threads
 * often arrive as bursts (a CC chain with three replies in 30 seconds). Rather
 * than run the full agent pipeline — context retrieval, classification, an LLM
 * draft — once per message, coalescing collapses a burst into a single pipeline
 * run on the most recent message. Earlier messages are superseded (archived
 * with reason `coalesced`); their content still reaches the agent because the
 * leader's `context_retrieval` step reads the whole thread.
 *
 * Mechanism: one in-flight `coalesceBatches` row per thread holds a scheduled
 * `processCoalescedBatch` job. Each new message cancels and re-schedules that
 * job `coalesceWindowMs` into the future, so the batch normally fires once the
 * thread goes quiet for a full window. A hard cap (`COALESCE_MAX_WAIT_MULTIPLIER
 * * window`, measured from the burst's first message) forces an immediate flush
 * so a continuously-active thread can't restart the debounce forever and starve
 * its pipeline run.
 *
 * Opt-in: coalescing is active only when `agentConfig.coalesceWindowMs` is set
 * to a positive value. Unset (the default) means each message is processed
 * immediately, with no added latency. `receiveMessage` decides whether to defer
 * by calling `shouldCoalesce`; if it defers, it does NOT start the walker — the
 * batch does.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';

/**
 * Default coalescing window in milliseconds (30 seconds)
 */
export const DEFAULT_COALESCE_WINDOW_MS = 30_000;

/**
 * Hard-cap multiplier: a burst may defer at most `window * this` from its first
 * message. The pure sliding window restarts the debounce on every message, so a
 * continuously-active thread (one new message every <window) would never flush.
 * Once the burst has been open this long we flush immediately instead of
 * deferring another full window — bounding worst-case reply latency.
 */
export const COALESCE_MAX_WAIT_MULTIPLIER = 5;

/**
 * Register an inbound message into its thread's coalesce window. Cancels and
 * re-schedules the thread's pending batch so the debounce timer restarts on
 * every new message. Always returns `{ shouldDefer: true }` — the caller must
 * NOT start the agent pipeline; `processCoalescedBatch` will, once the window
 * elapses with no further activity.
 */
export const shouldCoalesce = internalMutation({
	args: {
		threadId: v.id('conversationThreads'),
		messageId: v.id('inboundMessages'),
		coalesceWindowMs: v.number(),
	},
	handler: async (ctx, args): Promise<{ shouldDefer: boolean }> => {
		const windowMs = args.coalesceWindowMs > 0 ? args.coalesceWindowMs : DEFAULT_COALESCE_WINDOW_MS;
		const maxWaitMs = windowMs * COALESCE_MAX_WAIT_MULTIPLIER;
		const now = Date.now();

		// Cancel + drop every existing batch for this thread, then create exactly
		// one fresh one. Handling the set uniformly (rather than .first()) keeps
		// the invariant "one in-flight batch per thread" even if two near-
		// simultaneous receives both raced past an empty table — the loser's
		// orphaned job is cancelled here rather than left dangling.
		const existing = await ctx.db
			.query('coalesceBatches')
			.withIndex('by_thread', (q) => q.eq('threadId', args.threadId))
			.collect(); // bounded: one thread's coalesce batches

		// Preserve the burst's start across debounce restarts so the hard cap is
		// measured from the FIRST message, not the latest. A fresh burst (no
		// existing batch) starts at `now`.
		const firstReceivedAt = existing.reduce<number>(
			(min, b) => Math.min(min, b.firstReceivedAt ?? b.createdAt),
			now
		);

		for (const batch of existing) {
			await ctx.scheduler.cancel(batch.jobId);
			await ctx.db.delete(batch._id);
		}

		// Hard cap: once the burst has been open for `maxWaitMs`, flush immediately
		// (delay 0) instead of deferring another full window, so a continuously
		// active thread can't starve its pipeline run forever.
		const capped = existing.length > 0 && now - firstReceivedAt >= maxWaitMs;
		const jobId = await ctx.scheduler.runAfter(
			capped ? 0 : windowMs,
			internal.agent.coalescing.processCoalescedBatch,
			{ threadId: args.threadId }
		);
		await ctx.db.insert('coalesceBatches', {
			threadId: args.threadId,
			jobId,
			leaderMessageId: args.messageId,
			createdAt: now,
			firstReceivedAt,
		});
		return { shouldDefer: true };
	},
});

/**
 * Fire one coalesced batch for a thread: pick the most recent still-`received`
 * message as the leader, supersede the rest (archive with reason `coalesced`),
 * and start the agent pipeline for the leader only.
 */
export const processCoalescedBatch = internalMutation({
	args: {
		threadId: v.id('conversationThreads'),
	},
	handler: async (ctx, args) => {
		const batches = await ctx.db
			.query('coalesceBatches')
			.withIndex('by_thread', (q) => q.eq('threadId', args.threadId))
			.collect(); // bounded: one thread's coalesce batches
		for (const batch of batches) await ctx.db.delete(batch._id);

		// All messages on this thread still waiting at the gate.
		const pending = (
			await ctx.db
				.query('inboundMessages')
				.withIndex('by_thread', (q) => q.eq('threadId', args.threadId))
				.collect()
		) // bounded: one thread's inbound messages
			.filter((m) => m.processingStatus === 'received');

		if (pending.length === 0) return;

		// Leader = newest received message; the agent drafts one reply for it,
		// with the older messages folded in as thread context.
		pending.sort((a, b) => b.receivedAt - a.receivedAt);
		const leader = pending[0]!;
		const now = Date.now();

		// Supersede the older messages in the burst.
		for (const msg of pending.slice(1)) {
			await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
				inboundMessageId: msg._id,
				input: { to: 'archived', at: now, reason: 'coalesced' },
			});
		}

		// Run the full pipeline for the leader.
		await ctx.scheduler.runAfter(0, internal.agent.walker.start, {
			inboundMessageId: leader._id,
		});
	},
});
