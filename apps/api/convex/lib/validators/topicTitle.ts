/**
 * `mailThreads.topicTitle`: what a conversation is about, in a few words, for
 * the People view. A subject line ("Re: AW: quick question") rarely says that,
 * so the title is written by the model from the thread (`source: 'ai'`) or by
 * the owner (`source: 'user'`). An owner's title is never overwritten.
 *
 * `text` is SEALED like every other string derived from mail
 * (`lib/messageBody.ts`); reads open it with `openMessageBody`.
 */

import { v, type Infer } from 'convex/values';

export const topicTitleValidator = v.object({
	text: v.string(), // sealed
	source: v.union(v.literal('ai'), v.literal('user')),
	// The thread's message count when the title was written: a model title is
	// looked at again only once the thread has grown well past it.
	messageCount: v.number(),
	updatedAt: v.number(),
});

export type TopicTitle = Infer<typeof topicTitleValidator>;
