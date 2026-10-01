/**
 * The Answer mode catch-up card: a structured thread summary.
 *
 * `sentences` retell the thread oldest to newest; each sentence names the
 * messages it came from, and a sentence without a source is dropped before it is
 * stored. `asks` are the concrete things the other side wants, taken from the
 * newest inbound message plus earlier asks still open; the web ticks each one off
 * as the draft covers it. Message ids are strings because the same shape serves
 * Postbox threads (mailMessages) and team threads (inboundMessages).
 */

import { v } from 'convex/values';

export const catchUpSentenceValidator = v.object({
	text: v.string(),
	sourceMessageIds: v.array(v.string()),
});

export const catchUpAskValidator = v.object({
	// Stable within one summary ("ask_1"...), used by the coverage check.
	id: v.string(),
	text: v.string(),
	sourceMessageId: v.string(),
});

export const catchUpValidator = v.object({
	sentences: v.array(catchUpSentenceValidator),
	asks: v.array(catchUpAskValidator),
	// Message count the summary was built from; a newer count invalidates it.
	messageCount: v.number(),
	// Interface locale the sentences are written in.
	locale: v.string(),
	generatedAt: v.number(),
});
