<script setup lang="ts">
/**
 * A company's tile: its initial on the identity palette the sender avatars
 * use, keyed by the domain so a company keeps its colour everywhere. A rounded
 * square rather than a circle, so a company never reads as a person.
 *
 * No logo image: sender logos are attached to messages that passed DMARC
 * (`mail/senderLogos/`), and nothing serves one by domain. Decorative; the
 * name beside it is the label.
 */
import { AVATAR_COLOR_STYLES, initialsAndColorForAddress } from '~/utils/avatar';

const props = withDefaults(
	defineProps<{ companyKey: string; name: string; size?: 'sm' | 'md' | 'lg' }>(),
	{
		size: 'md',
	}
);

const style = computed(() => {
	const { colorToken } = initialsAndColorForAddress(props.companyKey);
	return AVATAR_COLOR_STYLES[colorToken];
});
const initial = computed(() =>
	(props.name.trim().charAt(0) || props.companyKey.charAt(0)).toUpperCase()
);
const sizeClass = computed(
	() =>
		({
			sm: 'h-6 w-6 rounded-md text-2xs',
			md: 'h-8 w-8 rounded-lg text-xs',
			lg: 'h-12 w-12 rounded-xl text-lg',
		})[props.size]
);
</script>

<template>
	<span
		class="inline-flex shrink-0 select-none items-center justify-center font-medium"
		:class="sizeClass"
		:style="style"
		aria-hidden="true"
		data-testid="company-logo"
		>{{ initial }}</span
	>
</template>
