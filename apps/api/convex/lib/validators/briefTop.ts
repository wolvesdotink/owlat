/**
 * `mailThreads.briefTop`: the thread brief folded down to what a list row,
 * the Answer queue and the Workbench show without reading the brief itself
 * (SPEC §7 "PostboxThreadRowBody shows the top item instead of the snippet").
 *
 * A projection, rewritten by `mail/interpret/briefTop.ts refreshBriefTop`
 * whenever the thread's items change. The texts are SEALED like every other
 * string derived from mail (`lib/messageBody.ts`); list reads open them at
 * their boundary (`openBriefTop`).
 */

import { v, type Infer } from 'convex/values';
import {
	interpretModeValidator,
	itemResponsibilityValidator,
	localizedSealedTextValidator,
} from './threadBrief';

export const briefTopValidator = v.object({
	// `brief` for personal mailboxes, `actions` for shared ones: a shared row
	// shows the item AND the raw snippet, never a latest-update line.
	mode: interpretModeValidator,
	// Open items owed by us (the thread's maintained `forUsCount`; unclear
	// ownership and unconfirmed proposals are counted apart).
	forYou: v.number(),
	// Open items owed by the other side.
	waiting: v.number(),
	// The first item of the `forUs` list (soonest due, else earliest asked),
	// else of `waitingOnOthers`.
	top: v.optional(
		v.object({
			itemId: v.id('threadItems'),
			// The list it heads; absent on rows written before it existed.
			bucket: v.optional(v.union(v.literal('forUs'), v.literal('waitingOnOthers'))),
			responsibility: itemResponsibilityValidator,
			text: localizedSealedTextValidator,
			dueAt: v.optional(v.number()),
		})
	),
	// The first "Latest update" line (brief mode only).
	latest: v.optional(localizedSealedTextValidator),
	// The brief's interpretationRevision this was folded at.
	revision: v.number(),
	updatedAt: v.number(),
});

export type BriefTop = Infer<typeof briefTopValidator>;
