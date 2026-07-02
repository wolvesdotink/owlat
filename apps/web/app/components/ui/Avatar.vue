<script setup lang="ts">
import {
	AVATAR_BG_CLASSES,
	AVATAR_COLOR_STYLES,
	AVATAR_SIZE_CLASSES,
	avatarInitials,
	initialsAndColorForAddress,
	type AvatarBg,
	type AvatarSize,
} from '~/utils/avatar';

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
		/**
		 * Deterministic identity coloring (Postbox sender/recipient avatars):
		 * hashes the email (preferred) or name onto the fixed accessible palette
		 * and uses word-aware initials ("Ada Lovelace" -> "AL", "jane.doe@x" ->
		 * "JD"). Overrides `bg` and the neutral initials style.
		 */
		deterministicColor?: boolean;
	}>(),
	{
		name: null,
		email: null,
		image: null,
		size: 'sm',
		bg: 'surface',
		deterministicColor: false,
	},
);

const identity = computed(() => {
	if (!props.deterministicColor) return null;
	const nameOrEmail = props.name?.trim() || props.email?.trim();
	if (!nameOrEmail) return null;
	return initialsAndColorForAddress(nameOrEmail, {
		colorKey: props.email?.trim() || undefined,
	});
});
const initials = computed(() =>
	identity.value ? identity.value.initials : avatarInitials(props.name, props.email)
);
const sizeClass = computed(() => AVATAR_SIZE_CLASSES[props.size]);
const bgClass = computed(() => (identity.value ? '' : AVATAR_BG_CLASSES[props.bg]));
const colorStyle = computed(() =>
	identity.value ? AVATAR_COLOR_STYLES[identity.value.colorToken] : undefined
);
</script>

<template>
	<div
		class="rounded-full border border-border-subtle flex items-center justify-center font-medium overflow-hidden"
		:class="[sizeClass, bgClass]"
		:style="colorStyle"
	>
		<img v-if="image" :src="image" :alt="name ?? ''" class="w-full h-full object-cover" />
		<span v-else>{{ initials }}</span>
	</div>
</template>
