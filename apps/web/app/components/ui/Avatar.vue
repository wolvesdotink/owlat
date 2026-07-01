<script setup lang="ts">
import { AVATAR_BG_CLASSES, AVATAR_SIZE_CLASSES, avatarInitials, type AvatarBg, type AvatarSize } from '~/utils/avatar';

const props = withDefaults(
	defineProps<{
		/** Display name; first identity used for initials. */
		name?: string | null;
		/** Email; used for initials when no name is present. */
		email?: string | null;
		/** Avatar image URL; when set, renders an <img> instead of initials. */
		image?: string | null;
		/** Diameter preset. Defaults to `sm` (w-6 h-6). */
		size?: AvatarSize;
		/** Circle background. Defaults to `surface`. */
		bg?: AvatarBg;
	}>(),
	{
		name: null,
		email: null,
		image: null,
		size: 'sm',
		bg: 'surface',
	},
);

const initials = computed(() => avatarInitials(props.name, props.email));
const sizeClass = computed(() => AVATAR_SIZE_CLASSES[props.size]);
const bgClass = computed(() => AVATAR_BG_CLASSES[props.bg]);
</script>

<template>
	<div
		class="rounded-full border border-border-subtle flex items-center justify-center font-medium overflow-hidden"
		:class="[sizeClass, bgClass]"
	>
		<img v-if="image" :src="image" :alt="name ?? ''" class="w-full h-full object-cover" />
		<span v-else>{{ initials }}</span>
	</div>
</template>
