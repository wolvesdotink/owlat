<script setup lang="ts">
import type { ConversationStatus } from '~/utils/conversationStatus';
import { SIDEBAR_JUMP_HINTS } from '~/composables/useSidebarJumpHints';

/**
 * One conversation in the sidebar: title, age, and at most one status pill.
 * Unread titles are set in the primary ink; the open conversation is
 * highlighted. `data-sidebar-jump` makes the row an Alt+1…9 target.
 */
const props = defineProps<{
	to: string;
	jumpKey: string;
	title: string;
	meta?: string;
	status?: ConversationStatus | null;
	isUnread?: boolean;
	isActive?: boolean;
	/** Indent under a group header (inbox rows) or sit flush (chat rows). */
	indented?: boolean;
	icon?: string;
}>();

const hints = inject(SIDEBAR_JUMP_HINTS, null);
const jumpNumber = computed(() =>
	hints?.show.value ? (hints.labels.value.get(props.jumpKey) ?? null) : null
);
</script>

<template>
	<NuxtLink
		:to="to"
		:data-sidebar-jump="jumpKey"
		:aria-current="isActive ? 'page' : undefined"
		class="group grid grid-cols-[1fr_auto] items-center gap-x-2 rounded-md py-1 pr-2 text-left transition-colors duration-(--motion-fast)"
		:class="[
			indented ? 'pl-7' : 'pl-3',
			isActive
				? 'bg-(--surface-2-selected) text-text-primary'
				: 'text-text-secondary hover:bg-(--surface-2-hover) hover:text-text-primary',
		]"
	>
		<span class="flex min-w-0 items-center gap-1.5">
			<Icon v-if="icon" :name="icon" class="size-3.5 shrink-0 text-text-tertiary" />
			<span
				class="truncate text-xs"
				:class="isUnread || isActive ? 'font-medium text-text-primary' : ''"
				>{{ title }}</span
			>
		</span>
		<span class="flex items-center justify-end">
			<kbd
				v-if="jumpNumber !== null"
				class="rounded bg-bg-elevated px-1 font-mono text-2xs leading-4 text-text-tertiary shadow-(--shadow-1)"
				>⌥{{ jumpNumber }}</kbd
			>
			<span v-else-if="meta" class="text-2xs tabular-nums text-text-tertiary">{{ meta }}</span>
		</span>
		<ShellStatusPill v-if="status" :status="status" class="col-span-2" />
	</NuxtLink>
</template>
