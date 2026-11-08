import type { Id } from '@owlat/api/dataModel';
import type { TodaySource } from '~/utils/todayDigest';

/** The longest title a Workbench line suggests for a task made from it. */
export const TODAY_TASK_TITLE_MAX = 140;

export interface TodayTaskContext {
	mailThreadId?: Id<'mailThreads'>;
	conversationThreadId?: Id<'conversationThreads'>;
	defaultTitle: string;
}

/**
 * What "Make task" on a Workbench line passes on: the conversation the line
 * came from (its first source) and the line's own words as a starting title.
 */
export function todayTaskContext(text: string, sources: readonly TodaySource[]): TodayTaskContext {
	const words = text.replace(/\s+/g, ' ').trim();
	const defaultTitle =
		words.length > TODAY_TASK_TITLE_MAX
			? `${words.slice(0, TODAY_TASK_TITLE_MAX - 1).trimEnd()}…`
			: words;
	const source = sources[0];
	if (!source) return { defaultTitle };
	return source.kind === 'mail'
		? { mailThreadId: source.threadId as Id<'mailThreads'>, defaultTitle }
		: { conversationThreadId: source.threadId as Id<'conversationThreads'>, defaultTitle };
}
