/**
 * The Team Inbox list's clock, provided to its rows instead of passed as a prop.
 *
 * A clock passed as a prop reaches every row on each tick and re-renders the
 * whole list to move the text of a few chips. A row that injects it reads it inside
 * computeds that return the chip's text and tier as strings, and a computed
 * whose string did not change does not re-render its row.
 */
import { inject, provide, type InjectionKey, type Ref } from 'vue';

export const INBOX_LIST_NOW_KEY: InjectionKey<Readonly<Ref<number>>> = Symbol('inboxListNow');

/** The list side: hand its clock (epoch ms) to every row rendered below. */
export function provideInboxListNow(now: Readonly<Ref<number>>): void {
	provide(INBOX_LIST_NOW_KEY, now);
}

/**
 * The row side: the list's clock, or null outside a list. A row without a
 * clock shows no waiting or deadline chip: it cannot know the time, so it must
 * not guess at an age.
 */
export function injectInboxListNow(): Readonly<Ref<number>> | null {
	return inject(INBOX_LIST_NOW_KEY, null);
}
