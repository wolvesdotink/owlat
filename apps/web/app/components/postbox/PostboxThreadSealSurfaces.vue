<script setup lang="ts">
/**
 * Thread-level Sealed-Mail trust surfaces (E5, flag `sealedMail`) for the reader.
 * Given the thread's correspondent (the 1:1 plane, locked decision D5), it reads
 * their PUBLIC key status once and renders:
 *   - PostboxKeyChangeBanner — Signal-style, only on an unsigned key change; its
 *     explicit "Accept new key" re-pins via `api.e2ee.recipientKeys.reacceptKeyChange`;
 *   - PostboxContactKeyPanel — the pinned fingerprint, first-seen, and source, so
 *     the reader can see who they are actually sealing to.
 *
 * Both are read/act-only over public material. The parent renders this only when
 * the `sealedMail` flag is on and a correspondent exists (one gate, one owner);
 * this component loads the correspondent's key status ONCE and hands it to the
 * contact-key panel. When there is no key status, it renders nothing.
 */
import { api } from '@owlat/api';
import { resolveContactVerification } from '~/utils/postboxKeyVerification';
import type { RecipientKeyStatus } from '~/utils/recipientKeyStatus';

const props = defineProps<{
	/** The thread's correspondent address (already lower-cased by the reader). */
	correspondent: string;
}>();

const statusQuery = useConvexQuery(api.e2ee.recipientKeys.getRecipientKeyStatus, () =>
	props.correspondent ? { address: props.correspondent } : ('skip' as const)
);

const status = computed(() => statusQuery.data.value as RecipientKeyStatus | null | undefined);

/**
 * Did a human here verify the key this contact just rotated AWAY from (plan idea
 * 54)? A key change is always worth reading; a key change to a key somebody
 * physically checked is worth stopping over, and the banner says so differently.
 * On a `keyChanged` row the pin is still the OLD key, so a verification that
 * matches the pin is a verification of the key being replaced.
 */
const wasVerified = computed(() => resolveContactVerification(status.value ?? {}) === 'verified');
</script>

<template>
	<div v-if="status">
		<PostboxKeyChangeBanner
			v-if="status.outcome === 'keyChanged'"
			:address="correspondent"
			:old-fingerprint="status.pinnedFingerprint"
			:new-fingerprint="status.observedFingerprint"
			:was-verified="wasVerified"
			@accepted="statusQuery.refetch()"
		/>
		<PostboxContactKeyPanel
			v-if="status.outcome !== 'notFound'"
			:address="correspondent"
			:status="status"
			@verification-changed="statusQuery.refetch()"
		/>
	</div>
</template>
