/**
 * What the brief's nested pieces need from the thread that hosts them, handed
 * down once by `ThreadBrief` rather than through every component in between:
 * who sent a cited message and when (for the source markers), and how to show
 * a cited quote.
 */
import type { InjectionKey } from 'vue';

export interface BriefSource {
	name?: string;
	email?: string;
	at?: number;
}

export interface BriefContext {
	/** The sender and date of a message of this thread, when it is loaded. */
	sourceOf: (messageId: string) => BriefSource | undefined;
	/** Show where a line comes from (`ref` is the item/fact id or `latest-<n>`). */
	cite: (ref: string, quoteIndex: number) => void;
}

export const BRIEF_CONTEXT: InjectionKey<BriefContext> = Symbol('threadBriefContext');

/** "7 Oct" / "7. Okt." in the UI locale. */
export function briefShortDate(at: number, locale: string): string {
	return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(at);
}

/**
 * A due date as people say it: the weekday within the coming week ("Fri"),
 * else weekday and date ("Fri 9 Oct").
 */
export function briefDueDate(at: number, locale: string, now: number = Date.now()): string {
	const days = (at - now) / 86_400_000;
	const opts: Intl.DateTimeFormatOptions =
		days >= 0 && days < 6
			? { weekday: 'short' }
			: { weekday: 'short', day: 'numeric', month: 'short' };
	return new Intl.DateTimeFormat(locale, opts).format(at);
}
