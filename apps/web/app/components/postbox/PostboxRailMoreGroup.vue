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
const props = defineProps<{
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

const expanded = computed(() => isOpen.value || holdsActiveRoute.value);
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
