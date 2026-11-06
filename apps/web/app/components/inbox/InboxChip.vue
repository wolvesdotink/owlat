<script setup lang="ts">
import { INBOX_SLOT_SWATCH, type InboxMark } from '~/utils/inboxIdentity';
import { INBOX_MARK_ICON_COMPONENTS } from '~/lib/inboxMarkIcons';
import InboxProviderLogo from './InboxProviderLogo.vue';

/**
 * An inbox's identity chip: a square swatch, the inbox's mark when it has one,
 * and its short name. The name is always shown, so the colour is a second
 * channel and never the only one (the square shape also sets it apart from the
 * round status dots). `markOnly` drops the name for the icon rail, whose
 * tooltip and label name the inbox instead.
 */
const props = withDefaults(
	defineProps<{
		name: string;
		slot: number | null;
		mark?: InboxMark | null;
		/** Show the mark without the name (the name stays when there is no mark). */
		markOnly?: boolean;
		/** `plain` drops the pill background (inline in running text). */
		variant?: 'pill' | 'plain';
		size?: 'sm' | 'md';
	}>(),
	{ mark: null, markOnly: false, variant: 'pill', size: 'sm' }
);

const swatch = computed(() =>
	props.slot === null ? 'bg-text-tertiary' : (INBOX_SLOT_SWATCH[props.slot] ?? 'bg-text-tertiary')
);
const markSize = computed(() => (props.size === 'sm' ? 'size-3' : 'size-3.5'));
</script>

<template>
	<span
		class="inline-flex max-w-full items-center gap-1.5 whitespace-nowrap font-medium text-text-secondary"
		:class="[
			variant === 'pill' ? 'rounded-full bg-bg-surface px-2 py-px' : '',
			size === 'sm' ? 'text-2xs' : 'text-xs',
		]"
	>
		<span class="size-1.5 shrink-0 rounded-[2px]" :class="swatch" aria-hidden="true" />
		<component
			:is="INBOX_MARK_ICON_COMPONENTS[mark.icon]"
			v-if="mark?.kind === 'icon'"
			class="shrink-0"
			:class="markSize"
			aria-hidden="true"
			:data-mark="`icon:${mark.icon}`"
		/>
		<span
			v-else-if="mark?.kind === 'emoji'"
			class="shrink-0 leading-none"
			:class="size === 'sm' ? 'text-xs' : 'text-sm'"
			aria-hidden="true"
			data-mark="emoji"
			>{{ mark.emoji }}</span
		>
		<InboxProviderLogo
			v-else-if="mark?.kind === 'provider'"
			:provider="mark.provider"
			class="shrink-0"
			:class="markSize"
			:data-mark="`provider:${mark.provider}`"
		/>
		<span v-if="!(markOnly && mark)" class="truncate">{{ name }}</span>
	</span>
</template>
