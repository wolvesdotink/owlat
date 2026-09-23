import { api } from '@owlat/api';

/**
 * Who is sending, for the recipient-facing pages (unsubscribe, preferences,
 * subscription confirmation).
 *
 * The person on these pages opened a link in someone else's email and has
 * never heard of Owlat, so the page leads with the sender's name. It is read
 * independently of the page's token because the error states — a broken or
 * expired link — are exactly where no token resolves, and they are where the
 * sender's address matters most (it is the other way to opt out).
 *
 * One-shot and best-effort: a failure leaves `sender` null and the page falls
 * back to its generic heading.
 */
export interface RecipientSender {
	name: string | null;
	contactEmail: string | null;
}

export function useRecipientSender() {
	const convex = useConvex();
	const sender = ref<RecipientSender | null>(null);

	onMounted(async () => {
		if (!convex) return;
		try {
			sender.value = await convex.query(api.delivery.unsubscribeQueries.getRecipientSender, {});
		} catch {
			// Best-effort: the generic heading is still a working page.
		}
	});

	return {
		sender,
		senderName: computed(() => sender.value?.name ?? null),
		contactEmail: computed(() => sender.value?.contactEmail ?? null),
	};
}
