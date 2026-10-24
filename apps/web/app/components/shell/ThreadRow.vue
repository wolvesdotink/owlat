<script setup lang="ts">
import type { ConversationStatus } from '~/utils/conversationStatus';
import { SIDEBAR_JUMP_HINTS } from '~/composables/useSidebarJumpHints';
import DraftMarker from '~/components/shell/DraftMarker.vue';
import type { ContextMenuItem } from '@owlat/ui/components/ui/ContextMenu.vue';
import RowContextMenu from '~/components/RowContextMenu.vue';
import { useRowLinkMenu } from '~/composables/useRowLinkMenu';

/**
 * One conversation in the sidebar: title, age, and at most one status pill.
 * Unread titles are set in the primary ink; the open conversation is
 * highlighted. `data-sidebar-jump` makes the row an Alt+1…9 target.
 *
 * Right-click (or a long-press) opens the row's menu: Open, the verbs its
 * group supplies, and the link verbs. The group knows what the row is; the
 * row never infers it from the URL.
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
	/** The viewer keeps unsent text here, on this device (the pencil). */
	hasDraft?: boolean;
	/** The group's own verbs for this row, built when the menu opens. */
	menuItems?: () => ContextMenuItem[];
}>();

const { linkItems, openItem } = useRowLinkMenu();
const items = () => {
	const own = props.menuItems?.() ?? [];
	if (own[0]) own[0] = { ...own[0], separatorBefore: true };
	return [openItem(props.to), ...own, ...linkItems(props.to)];
};

const hints = inject(SIDEBAR_JUMP_HINTS, null);
const jumpNumber = computed(() =>
	hints?.show.value ? (hints.labels.value.get(props.jumpKey) ?? null) : null
);
</script>

<template>
	<RowContextMenu :items="items">
		<template #default="{ rowBindings }">
			<NuxtLink
				v-bind="rowBindings"
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
					<DraftMarker v-if="hasDraft" />
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
	</RowContextMenu>
</template>
