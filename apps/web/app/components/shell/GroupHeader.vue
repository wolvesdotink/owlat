<script setup lang="ts">
import { ChevronDownIcon, PlusIcon } from '@coolicons/vue';

/**
 * A sidebar group's header, split the way a mailbox header is: the chevron
 * folds the group, the name opens the group's list page, and the optional "+"
 * creates one. A name that only folds reads as a link and goes nowhere.
 */
const props = defineProps<{
	name: string;
	to: string;
	collapsed: boolean;
	/** Typography of the name; it differs between a zone label and a group. */
	nameClass: string | readonly string[];
	/** Renders the name as a heading, for a zone label. */
	heading?: boolean;
	createTo?: string;
	createLabel?: string;
}>();
const emit = defineEmits<{ toggle: [] }>();

const { t } = useI18n();
const route = useRoute();
</script>

<template>
	<div class="flex items-center gap-1 pr-1">
		<button
			type="button"
			class="flex size-6 shrink-0 items-center justify-center rounded text-text-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand pointer-coarse:size-11"
			:aria-expanded="!props.collapsed"
			:aria-label="
				props.collapsed
					? t('components.shell.groupToggle.expand', { name: props.name })
					: t('components.shell.groupToggle.collapse', { name: props.name })
			"
			@click="emit('toggle')"
		>
			<ChevronDownIcon
				class="size-3 transition-transform duration-(--motion-fast)"
				:class="props.collapsed ? '-rotate-90' : ''"
			/>
		</button>
		<component :is="props.heading ? 'h2' : 'div'" class="flex min-w-0 flex-1">
			<NuxtLink
				:to="props.to"
				:aria-current="route.path === props.to ? 'page' : undefined"
				class="flex min-w-0 flex-1 items-center gap-2 py-1 hover:text-text-primary"
				:class="props.nameClass"
			>
				{{ props.name }}
				<slot />
			</NuxtLink>
		</component>
		<UiTooltip v-if="props.createTo" :text="props.createLabel">
			<NuxtLink
				:to="props.createTo"
				class="flex size-6 items-center justify-center rounded text-text-tertiary hover:text-text-primary pointer-coarse:size-11"
				:aria-label="props.createLabel"
			>
				<PlusIcon class="size-3.5" />
			</NuxtLink>
		</UiTooltip>
	</div>
</template>
