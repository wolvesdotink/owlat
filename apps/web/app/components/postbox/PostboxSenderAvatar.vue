<script setup lang="ts">
/**
 * A message sender's avatar in the list and the reader: the brand logo when
 * the server attached one, else the deterministic initials.
 *
 * `senderLogoUrl` is set by the list and reader reads only for a message that
 * passed DMARC from a non-webmail domain, and only when the viewer has logos
 * on (`mail/senderLogos/`). It points at this deployment's storage, never at
 * the sender, so drawing it tells the sender nothing. Decorative: the name
 * beside it is the accessible label.
 */
import type { AvatarSize } from '~/utils/avatar';

defineProps<{
	sender: { fromName?: string; fromAddress: string; senderLogoUrl?: string };
	size: AvatarSize;
}>();
</script>

<template>
	<UiAvatar
		:name="sender.fromName"
		:email="sender.fromAddress"
		:image="sender.senderLogoUrl"
		deterministic-color
		:size="size"
		aria-hidden="true"
	/>
</template>
