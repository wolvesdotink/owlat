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
 * Both are read/act-only over public material. When the flag is off, or there is
 * no key status for the correspondent, it renders nothing.
 */
import { api } from '@owlat/api';

const props = defineProps<{
	/** Feature-flag gate: when false, nothing renders. */
	enabled: boolean;
	/** The thread's correspondent address (already lower-cased by the reader). */
	correspondent: string;
}>();

const statusQuery = useConvexQuery(api.e2ee.recipientKeys.getRecipientKeyStatus, () =>
	props.enabled && props.correspondent ? { address: props.correspondent } : ('skip' as const)
);

type KeyStatus = {
	outcome: 'trusted' | 'keyChanged' | 'notFound';
	pinnedFingerprint: string | null;
	observedFingerprint: string | null;
	discoveredAt: number | null;
	source: string | null;
	expiresAt: number;
};

const status = computed(() => statusQuery.data.value as KeyStatus | null | undefined);
const showKeyChange = computed(() => props.enabled && status.value?.outcome === 'keyChanged');
</script>

<template>
	<div v-if="enabled && status">
		<PostboxKeyChangeBanner
			v-if="showKeyChange"
			:address="correspondent"
			:old-fingerprint="status.pinnedFingerprint"
			:new-fingerprint="status.observedFingerprint"
			@accepted="statusQuery.refetch()"
		/>
		<PostboxContactKeyPanel v-if="status.outcome !== 'notFound'" :address="correspondent" />
	</div>
</template>
