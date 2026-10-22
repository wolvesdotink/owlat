import { v, type Infer } from 'convex/values';

/**
 * A Team Inbox conversation's priority, set by a person. The words are the
 * agent's classification vocabulary (`low` / `normal` / `urgent`), so the
 * thread's own priority and the agent's read of a message speak the same
 * language. Stored only when it is not `normal`: an absent field IS normal, so
 * every thread written before the field existed reads correctly.
 */
export const teamThreadPriorityValidator = v.union(
	v.literal('low'),
	v.literal('normal'),
	v.literal('urgent')
);

export type TeamThreadPriority = Infer<typeof teamThreadPriorityValidator>;
