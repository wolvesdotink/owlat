<script setup lang="ts">
/**
 * The rail's long tail, behind one disclosure.
 *
 * Spam and Trash are destinations you rarely browse; Snoozed, Files,
 * Subscriptions and Contacts are second ways into mail you already have; Import
 * and Settings are setup-time. None of them is a daily click, and together they
 * were half the rail's height. They fold into one collapsed-by-default group
 * whose state persists, and the group carries Spam's unread count while folded
 * so nothing new can hide behind the fold.
 *
 * Import (`/dashboard/postbox/migrate`) had no entry point at all before this —
 * the wizard was reachable only by typing the URL. Folding the rail is what
 * finally made room to link it.
 */
import type { Id } from '@owlat/api/dataModel';
import { usePostboxMessageDropTargets } from '~/composables/postbox/usePostboxMessageDrag';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	/** Rail is the narrow icon strip. */
	collapsed: boolean;
	/** Spam and Trash, in rail order. */
	folders: Array<{
		_id: string;
		name: string;
		role?: string | null;
		unseenCount: number;
		totalCount: number;
	}>;
	/** Active folder role, so Spam/Trash/Snoozed can mark themselves current. */
	folderRole: string;
}>();

const { t } = useI18n();
const route = useRoute();

const { isOpen, toggle } = usePostboxRailMore();
const { openManager } = usePostboxManageDialog();

/** Unread that would otherwise disappear behind the fold. */
const spamUnread = computed(
	() => props.folders.find((folder) => folder.role === 'spam')?.unseenCount ?? 0
);

/**
 * The non-folder destinations, in the order the plan lists them. `role` marks
 * the ones that are a virtual folder view, so the row can go current.
 */
const LINKS: Array<{ to: string; icon: string; labelKey: string; role: string }> = [
	{
		to: '/dashboard/postbox/snoozed',
		icon: 'lucide:clock',
		labelKey: 'components.postbox.postboxFolderRail.snoozed',
		role: 'snoozed',
	},
	{
		to: '/dashboard/postbox/files',
		icon: 'lucide:paperclip',
		labelKey: 'components.postbox.postboxFolderRail.files',
		role: '',
	},
	{
		to: '/dashboard/postbox/subscriptions',
		icon: 'lucide:bell-off',
		labelKey: 'components.postbox.postboxFolderRail.subscriptions',
		role: '',
	},
	{
		to: '/dashboard/postbox/contacts',
		icon: 'lucide:users',
		labelKey: 'components.postbox.postboxFolderRail.contacts',
		role: '',
	},
	{
		to: '/dashboard/postbox/migrate',
		icon: 'lucide:download',
		labelKey: 'components.postbox.postboxFolderRail.import',
		role: '',
	},
	{ to: '/dashboard/preferences', icon: 'lucide:settings', labelKey: 'common.settings', role: '' },
];

/**
 * Never fold the current location away. A route inside the group forces it open
 * regardless of the saved preference, so "where am I" survives the disclosure.
 */
const holdsActiveRoute = computed(
	() =>
		props.folders.some((folder) => folder.role === props.folderRole) ||
		LINKS.some((link) => route.path === link.to)
);

/**
 * Spring-loaded while a message is being dragged: hovering the folded header
 * for a beat opens it, so Spam and Trash are reachable drop targets. It folds
 * back when the drag ends and never touches the saved preference.
 */
const SPRING_OPEN_MS = 500;
const drop = usePostboxMessageDropTargets(computed(() => props.mailboxId));
const springOpen = ref(false);
let springTimer: ReturnType<typeof setTimeout> | undefined;

function armSpring() {
	if (!drop.active.value || springOpen.value || springTimer) return;
	springTimer = setTimeout(() => {
		springTimer = undefined;
		if (drop.active.value) springOpen.value = true;
	}, SPRING_OPEN_MS);
}

function disarmSpring() {
	clearTimeout(springTimer);
	springTimer = undefined;
}

function onHeaderDragleave(event: DragEvent) {
	// Crossing from the header onto its own icon or label is not leaving it.
	const into = event.relatedTarget as Node | null;
	if (into && (event.currentTarget as Node).contains(into)) return;
	disarmSpring();
}

watch(drop.active, (active) => {
	if (active) return;
	disarmSpring();
	springOpen.value = false;
});
onBeforeUnmount(disarmSpring);

const expanded = computed(() => isOpen.value || holdsActiveRoute.value || springOpen.value);
</script>

<template>
	<div :class="collapsed ? 'flex flex-col items-center gap-1 w-full' : 'w-full'">
		<button
			type="button"
			class="rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface"
			:class="
				collapsed
					? 'relative flex items-center justify-center w-9 h-9'
					: 'flex items-center gap-2 px-2.5 py-1.5 w-full text-sm'
			"
			:aria-expanded="expanded"
			:title="collapsed ? t('components.postbox.postboxRailMoreGroup.more') : undefined"
			:aria-label="
				spamUnread > 0 && !expanded
					? t('components.postbox.postboxRailMoreGroup.moreUnreadAriaLabel', {
							count: spamUnread,
						})
					: t('components.postbox.postboxRailMoreGroup.more')
			"
			@click="toggle"
			@dragenter="armSpring"
			@dragleave="onHeaderDragleave"
		>
			<Icon
				v-if="collapsed"
				:name="expanded ? 'lucide:chevron-up' : 'lucide:ellipsis'"
				class="w-4 h-4"
			/>
			<template v-else>
				<Icon
					:name="expanded ? 'lucide:chevron-down' : 'lucide:chevron-right'"
					class="w-4 h-4 flex-shrink-0"
				/>
				<span class="flex-1 text-left">{{
					t('components.postbox.postboxRailMoreGroup.more')
				}}</span>
				<!-- Spam's unread bubbles up while the group is folded, so folding it
				     never hides new mail. -->
				<span
					v-if="spamUnread > 0 && !expanded"
					class="text-xs font-medium text-text-secondary flex-shrink-0"
					>{{ spamUnread }}</span
				>
			</template>
			<span
				v-if="collapsed && spamUnread > 0 && !expanded"
				class="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-brand text-text-inverse text-2xs leading-4 font-medium text-center"
				>{{ spamUnread > 99 ? '99+' : spamUnread }}</span
			>
		</button>

		<div
			v-if="expanded"
			:class="collapsed ? 'flex flex-col items-center gap-1' : 'flex flex-col gap-0.5 mt-0.5 pl-2'"
		>
			<PostboxFolderList
				:mailbox-id="mailboxId"
				:folders="folders"
				:unread-counts="{}"
				:active-folder="folderRole"
				:collapsed="collapsed"
			/>
			<PostboxRailLink
				v-for="link in LINKS"
				:key="link.to"
				:to="link.to"
				:icon="link.icon"
				:label="t(link.labelKey)"
				:collapsed="collapsed"
				:active="!!link.role && link.role === folderRole"
				muted
			/>
			<!-- The one CRUD surface. The rail's rows are navigation; creating,
			     renaming and deleting folders and labels all happen in here. -->
			<button
				type="button"
				class="rounded text-sm text-text-tertiary hover:text-text-secondary hover:bg-bg-surface"
				:class="
					collapsed
						? 'flex items-center justify-center w-9 h-9'
						: 'flex items-center gap-2 px-2.5 py-1.5 w-full text-left'
				"
				:title="collapsed ? t('components.postbox.postboxLabelManager.title') : undefined"
				:aria-label="collapsed ? t('components.postbox.postboxLabelManager.title') : undefined"
				@click="openManager({ section: 'folders' })"
			>
				<Icon name="lucide:settings-2" class="w-4 h-4 flex-shrink-0" />
				<span v-if="!collapsed" class="flex-1 truncate">{{
					t('components.postbox.postboxLabelManager.title')
				}}</span>
			</button>
		</div>
	</div>
</template>
