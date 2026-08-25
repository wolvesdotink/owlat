/**
 * IMAP STORE — flag writes (see mail/imap/ for the module overview).
 *
 * Every mutation here bumps the folder's `highestModseq` so CONDSTORE/QRESYNC
 * clients can resync incrementally; UID / modseq allocation stays behind these
 * functions so the IMAP server never needs to know the storage shape.
 *
 * The flag vocabulary lives here too: `isImapSystemFlag` is the one place that
 * decides what counts as a system flag, and APPEND reads it from here rather
 * than repeating the test.
 */

import { v } from 'convex/values';
import { internalMutation } from '../../_generated/server';
import type { Id, Doc } from '../../_generated/dataModel';
import { bumpFolderModseq } from '../folders';

const IMAP_FLAG_TO_FIELD: Record<string, keyof Doc<'mailMessages'>> = {
	'\\seen': 'flagSeen',
	'\\flagged': 'flagFlagged',
	'\\answered': 'flagAnswered',
	'\\draft': 'flagDraft',
	'\\deleted': 'flagDeleted',
};

export function isImapSystemFlag(flag: string): boolean {
	return flag.startsWith('\\');
}

interface FlagDelta {
	systemFlags: Partial<
		Record<'flagSeen' | 'flagFlagged' | 'flagAnswered' | 'flagDraft' | 'flagDeleted', boolean>
	>;
	customFlagsAdd: string[];
	customFlagsRemove: string[];
}

function buildFlagDelta(rawFlags: string[], mode: 'set' | 'add' | 'remove'): FlagDelta {
	const delta: FlagDelta = {
		systemFlags: {},
		customFlagsAdd: [],
		customFlagsRemove: [],
	};
	for (const f of rawFlags) {
		const lower = f.toLowerCase();
		if (isImapSystemFlag(lower)) {
			const field = IMAP_FLAG_TO_FIELD[lower];
			if (!field) continue;
			delta.systemFlags[field as keyof FlagDelta['systemFlags']] = mode !== 'remove';
		} else {
			if (mode === 'remove') delta.customFlagsRemove.push(f);
			else delta.customFlagsAdd.push(f);
		}
	}
	return delta;
}

/**
 * STORE / UID STORE — apply a flag change to one or more messages.
 *
 * `mode` mirrors IMAP semantics: `set` overrides ALL flags with the
 * provided list, `add` (`+FLAGS`) ORs them in, `remove` (`-FLAGS`) clears.
 */
export const storeFlags = internalMutation({
	args: {
		messageIds: v.array(v.id('mailMessages')),
		flags: v.array(v.string()),
		mode: v.union(v.literal('set'), v.literal('add'), v.literal('remove')),
		unchangedSinceModseq: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const updated: Array<{
			messageId: Id<'mailMessages'>;
			uid: number;
			modseq: number;
			flags: string[];
		}> = [];
		const unchanged: Array<{ messageId: Id<'mailMessages'>; uid: number }> = [];

		const folderUnseenDelta = new Map<Id<'mailFolders'>, number>();

		const delta = buildFlagDelta(args.flags, args.mode);

		for (const id of args.messageIds) {
			const message = await ctx.db.get(id);
			if (!message) continue;

			// CONDSTORE: skip messages that have changed since the requested
			// baseline. The IMAP server reports them in the MODIFIED response.
			if (args.unchangedSinceModseq !== undefined && message.modseq > args.unchangedSinceModseq) {
				unchanged.push({ messageId: message._id, uid: message.uid });
				continue;
			}

			const wasSeen = message.flagSeen;
			const patch: Partial<Doc<'mailMessages'>> = { updatedAt: Date.now() };

			if (args.mode === 'set') {
				patch.flagSeen = !!delta.systemFlags.flagSeen;
				patch.flagFlagged = !!delta.systemFlags.flagFlagged;
				patch.flagAnswered = !!delta.systemFlags.flagAnswered;
				patch.flagDraft = !!delta.systemFlags.flagDraft;
				patch.flagDeleted = !!delta.systemFlags.flagDeleted;
				patch.customFlags = delta.customFlagsAdd;
			} else {
				if (delta.systemFlags.flagSeen !== undefined) patch.flagSeen = delta.systemFlags.flagSeen;
				if (delta.systemFlags.flagFlagged !== undefined)
					patch.flagFlagged = delta.systemFlags.flagFlagged;
				if (delta.systemFlags.flagAnswered !== undefined)
					patch.flagAnswered = delta.systemFlags.flagAnswered;
				if (delta.systemFlags.flagDraft !== undefined)
					patch.flagDraft = delta.systemFlags.flagDraft;
				if (delta.systemFlags.flagDeleted !== undefined)
					patch.flagDeleted = delta.systemFlags.flagDeleted;
				if (delta.customFlagsAdd.length > 0 || delta.customFlagsRemove.length > 0) {
					const next = new Set(message.customFlags);
					for (const f of delta.customFlagsAdd) next.add(f);
					for (const f of delta.customFlagsRemove) next.delete(f);
					patch.customFlags = Array.from(next);
				}
			}

			// One write path for the folder modseq: bumpFolderModseq reads the
			// folder's persisted highestModseq (which the previous iteration in
			// this batch already patched) and increments it.
			const folderModseqValue = await bumpFolderModseq(ctx, message.folderId);
			patch.modseq = folderModseqValue;

			await ctx.db.patch(id, patch);

			const newSeen = patch.flagSeen ?? message.flagSeen;
			if (newSeen !== wasSeen) {
				const cur = folderUnseenDelta.get(message.folderId) ?? 0;
				folderUnseenDelta.set(message.folderId, cur + (newSeen ? -1 : +1));
			}

			const finalCustom = patch.customFlags ?? message.customFlags;
			const flagsOut: string[] = [];
			if (patch.flagSeen ?? message.flagSeen) flagsOut.push('\\Seen');
			if (patch.flagFlagged ?? message.flagFlagged) flagsOut.push('\\Flagged');
			if (patch.flagAnswered ?? message.flagAnswered) flagsOut.push('\\Answered');
			if (patch.flagDraft ?? message.flagDraft) flagsOut.push('\\Draft');
			if (patch.flagDeleted ?? message.flagDeleted) flagsOut.push('\\Deleted');
			for (const f of finalCustom) flagsOut.push(f);

			updated.push({
				messageId: message._id,
				uid: message.uid,
				modseq: folderModseqValue,
				flags: flagsOut,
			});
		}

		// Apply unseen deltas
		for (const [folderId, deltaCount] of folderUnseenDelta) {
			const folder = await ctx.db.get(folderId);
			if (!folder) continue;
			await ctx.db.patch(folderId, {
				unseenCount: Math.max(0, folder.unseenCount + deltaCount),
				updatedAt: Date.now(),
			});
		}

		return { updated, unchanged };
	},
});
