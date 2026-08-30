import { api } from '@owlat/api';
import type { RecipientKeyStatus } from '~/utils/recipientKeyStatus';

/**
 * The thread correspondent's PUBLIC sealing-key status (Sealed Mail E5, flag
 * `sealedMail`), read ONCE for the whole conversation.
 *
 * Previously owned by PostboxThreadSealSurfaces, which rendered both trust
 * surfaces itself. The two have different homes now (plan §05): the key-change
 * banner is an alarm and stays at thread level, while the key PANEL — pinned
 * fingerprint, first seen, source, the human verification ritual — moved into
 * the sender's trust chip popover. Hoisting the query here keeps that one
 * subscription per thread, and lets the chip go amber on a key change without
 * opening a second read.
 *
 * `correspondent` is a getter so the reader can pass its computed 1:1 plane
 * (locked decision D5); an empty address skips the query entirely.
 */
export function usePostboxCorrespondentKey(correspondent: () => string) {
	const statusQuery = useConvexQuery(api.e2ee.recipientKeys.getRecipientKeyStatus, () =>
		correspondent() ? { address: correspondent() } : ('skip' as const)
	);

	const status = computed(
		() => (statusQuery.data.value as RecipientKeyStatus | null | undefined) ?? null
	);

	/**
	 * Did a human here verify the key this contact just rotated AWAY from (plan
	 * idea 54)? A key change is always worth reading; a key change to a key
	 * somebody physically checked is worth stopping over, and the banner says so
	 * differently. On a `keyChanged` row the pin is still the OLD key, so a
	 * verification that matches the pin is a verification of the key being
	 * replaced.
	 */
	const wasVerified = computed(() => resolveContactVerification(status.value ?? {}) === 'verified');

	/** An unsigned key rotation — the one state that raises a banner. */
	const keyChanged = computed(() => status.value?.outcome === 'keyChanged');

	return { status, wasVerified, keyChanged, refetch: () => statusQuery.refetch() };
}
