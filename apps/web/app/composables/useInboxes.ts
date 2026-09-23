import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { resolveInboxIdentities, type InboxIdentity } from '~/utils/inboxIdentity';

/**
 * Every inbox the viewer can read — their own mailboxes plus the team inboxes
 * they belong to — with a resolved identity (short name + colour slot).
 *
 * Reads `mail.mailbox.queries.accessible`, the same own-plus-member set the
 * mailbox switcher uses, so an admin never sees a teammate's private mailbox
 * advertised here. The Convex client dedupes the subscription across callers
 * (sidebar, Today, Answer queue, composer).
 */
export function useInboxes() {
	const { isEnabled } = useFeatureFlag();
	const hasPersonalMail = computed(() => isEnabled('postbox') || isEnabled('mail.external'));

	const { data, isLoading } = useConvexQuery(api.mail.mailbox.queries.accessible, () =>
		hasPersonalMail.value ? {} : 'skip'
	);

	const inboxes = computed<InboxIdentity<Id<'mailboxes'>>[]>(() =>
		resolveInboxIdentities(data.value ?? [])
	);
	const byId = computed(() => new Map(inboxes.value.map((inbox) => [inbox.mailboxId, inbox])));
	const ids = computed(() => inboxes.value.map((inbox) => inbox.mailboxId));

	return {
		inboxes,
		byId,
		ids,
		hasPersonalMail,
		isLoading: computed(() => hasPersonalMail.value && isLoading.value),
	};
}
