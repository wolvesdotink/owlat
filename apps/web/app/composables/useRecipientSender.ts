import { api } from '@owlat/api';

/**
 * Who is sending, for the recipient-facing pages (unsubscribe, preferences,
 * subscription confirmation) and the other pages people reach without an
 * account (sign-in, invitations).
 *
 * The person on these pages opened a link in someone else's email and has
 * never heard of Owlat, so the page leads with the sender's name and logo. It
 * is read independently of the page's token because the error states — a
 * broken or expired link — are exactly where no token resolves, and they are
 * where the sender's address matters most (it is the other way to opt out).
 *
 * One-shot and best-effort: a failure leaves `sender` null and the page falls
 * back to its generic heading.
 */
export interface RecipientSender {
	name: string | null;
	contactEmail: string | null;
	/** The workspace logo for light backgrounds; `null` when none is set. */
	logoUrl?: string | null;
	/** The logo for dark backgrounds; `null` to draw the light one instead. */
	logoDarkUrl?: string | null;
}

/** A workspace logo ready to render, see `WorkspaceLogo.vue`. */
export interface RecipientLogo {
	url: string;
	darkUrl: string | null;
}

/**
 * A page and the shell around it (the sign-in page and `AuthShell`) both ask
 * on mount; they share one request instead of sending two.
 */
let inFlight: Promise<RecipientSender | null> | null = null;

export function useRecipientSender() {
	const convex = useConvex();
	const sender = ref<RecipientSender | null>(null);

	onMounted(async () => {
		if (!convex) return;
		inFlight ??= Promise.resolve(
			convex.query(api.delivery.unsubscribeQueries.getRecipientSender, {})
		).finally(() => {
			inFlight = null;
		});
		try {
			sender.value = await inFlight;
		} catch {
			// Best-effort: the generic heading is still a working page.
		}
	});

	return {
		sender,
		senderName: computed(() => sender.value?.name ?? null),
		contactEmail: computed(() => sender.value?.contactEmail ?? null),
		logo: computed<RecipientLogo | null>(() =>
			sender.value?.logoUrl
				? { url: sender.value.logoUrl, darkUrl: sender.value.logoDarkUrl ?? null }
				: null
		),
	};
}
