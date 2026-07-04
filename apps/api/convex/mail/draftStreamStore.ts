/**
 * Owner-scoped persistence for the whole-draft REVISE stream buffers
 * (`aiDraftStreams`). The freeform-instruction revise loop needs a reactive
 * channel so tokens render progressively into the composer / review pane; a
 * Convex action cannot push to the client directly, so it throttle-patches an
 * owner-private scratch row here and the client subscribes via {@link getDraftStream}.
 *
 * Split from the streaming action (mail/reviseDraft.ts, a `'use node'` module
 * that can hold ONLY actions) because these are queries/mutations. Mirrors the
 * assistant streaming pattern (assistant/conversations.ts patch/finalize).
 *
 * Privacy: every read is gated on `row.ownerId === caller`. The internal
 * append/finalize writers are only ever invoked by the reviseDraft action AFTER
 * {@link beginDraftStream} has proven the caller owns the row, so they patch by
 * id without re-checking.
 */

import { v } from 'convex/values';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import { internalMutation } from '../_generated/server';
import { getMutationContext, getUserIdFromSession } from '../lib/sessionOrganization';
import { tokenUsageValidator } from '../lib/convexValidators';
import { throwForbidden, throwNotFound } from '../_utils/errors';

/** Cap the persisted streaming text so a runaway model cannot bloat a row. */
const DRAFT_STREAM_MAX_CHARS = 20000;

/**
 * Create an empty, owner-private stream buffer and return its id. The client
 * calls this first, subscribes to {@link getDraftStream}, THEN invokes the
 * reviseDraft action with the returned id — so the subscription is live before
 * the first token lands.
 */
// all-members: a member owns their own transient revise buffer (owner-scoped).
export const createDraftStream = authedMutation({
	args: {
		surface: v.union(v.literal('compose'), v.literal('review')),
	},
	handler: async (ctx, args) => {
		const { userId } = await getMutationContext(ctx);
		const now = Date.now();
		return ctx.db.insert('aiDraftStreams', {
			ownerId: userId,
			surface: args.surface,
			status: 'streaming',
			text: '',
			createdAt: now,
			updatedAt: now,
		});
	},
});

/**
 * Prove the caller owns the buffer before the action starts streaming into it.
 * Returns nothing; throws forbidden/not-found on mismatch. Called ONCE by the
 * reviseDraft action so the cheaper per-delta {@link appendDraftStream} does not
 * re-run the membership check.
 */
export const beginDraftStream = internalMutation({
	args: { streamId: v.id('aiDraftStreams') },
	handler: async (ctx, args) => {
		const userId = await getUserIdFromSession(ctx);
		const row = await ctx.db.get(args.streamId);
		if (!row) throwNotFound('Draft stream');
		if (row.ownerId !== userId) throwForbidden('You do not own this draft stream');
		// Reset to a clean streaming state (the client may re-run revise on the
		// same buffer with a new instruction — the clarification-answer loop).
		await ctx.db.patch(args.streamId, {
			status: 'streaming',
			text: '',
			isInjectionFlagged: undefined,
			errorMessage: undefined,
			updatedAt: Date.now(),
		});
	},
});

/**
 * Append accumulated streaming text. Returns `{ stop }` so the action aborts the
 * model stream when the client has deleted/cancelled the buffer (row gone or no
 * longer `streaming`) — mirrors the assistant runner's cooperative stop.
 */
export const appendDraftStream = internalMutation({
	args: {
		streamId: v.id('aiDraftStreams'),
		text: v.string(),
	},
	handler: async (ctx, args): Promise<{ stop: boolean }> => {
		const row = await ctx.db.get(args.streamId);
		if (!row || row.status !== 'streaming') return { stop: true };
		await ctx.db.patch(args.streamId, {
			text: args.text.slice(0, DRAFT_STREAM_MAX_CHARS),
			updatedAt: Date.now(),
		});
		return { stop: false };
	},
});

/** Write the final text + terminal status once the stream settles. */
export const finalizeDraftStream = internalMutation({
	args: {
		streamId: v.id('aiDraftStreams'),
		text: v.string(),
		status: v.union(v.literal('complete'), v.literal('error')),
		injectionFlagged: v.optional(v.boolean()),
		model: v.optional(v.string()),
		tokenUsage: v.optional(tokenUsageValidator),
		errorMessage: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const row = await ctx.db.get(args.streamId);
		// The client may have discarded the buffer mid-flight — nothing to write.
		if (!row) return;
		await ctx.db.patch(args.streamId, {
			text: args.text.slice(0, DRAFT_STREAM_MAX_CHARS),
			status: args.status,
			isInjectionFlagged: args.injectionFlagged,
			model: args.model,
			tokenUsage: args.tokenUsage,
			errorMessage: args.errorMessage,
			updatedAt: Date.now(),
		});
	},
});

/** Owner-scoped subscription target: the reactive read the client renders. */
// all-members: a member reads only their own revise buffer (owner-scoped).
export const getDraftStream = authedQuery({
	args: { streamId: v.id('aiDraftStreams') },
	handler: async (ctx, args) => {
		const userId = await getUserIdFromSession(ctx);
		const row = await ctx.db.get(args.streamId);
		if (!row || row.ownerId !== userId) return null;
		return {
			_id: row._id,
			status: row.status,
			text: row.text,
			injectionFlagged: row.isInjectionFlagged ?? false,
			errorMessage: row.errorMessage,
		};
	},
});

/** Delete a buffer once the client has applied/discarded the result. */
// all-members: a member deletes only their own revise buffer (owner-scoped).
export const deleteDraftStream = authedMutation({
	args: { streamId: v.id('aiDraftStreams') },
	handler: async (ctx, args) => {
		const userId = await getUserIdFromSession(ctx);
		const row = await ctx.db.get(args.streamId);
		if (!row) return;
		if (row.ownerId !== userId) throwForbidden('You do not own this draft stream');
		await ctx.db.delete(args.streamId);
	},
});
