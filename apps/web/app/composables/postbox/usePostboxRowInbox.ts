/**
 * The inbox chip on a message row. A list that spans mailboxes (All inboxes)
 * provides the lookup, and every row below it names the inbox it came from;
 * a single folder provides nothing, so its rows carry no chip.
 */

import { inject, provide, type InjectionKey, type Ref } from 'vue';
import type { InboxIdentity } from '~/utils/inboxIdentity';

type RowInboxLookup = (mailboxId: string) => InboxIdentity | null;

const ROW_INBOX_KEY: InjectionKey<RowInboxLookup> = Symbol('postbox-row-inbox');

export function providePostboxRowInbox(byId: Ref<ReadonlyMap<string, InboxIdentity>>) {
	provide(ROW_INBOX_KEY, (mailboxId) => byId.value.get(mailboxId) ?? null);
}

/** The lookup, or null outside a list that spans mailboxes. */
export function usePostboxRowInbox(): RowInboxLookup | null {
	return inject(ROW_INBOX_KEY, null);
}
