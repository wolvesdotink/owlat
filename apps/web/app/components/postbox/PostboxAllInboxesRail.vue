<script setup lang="ts">
/**
 * Pane 1 of All inboxes and the unified folders, where a single mailbox has its
 * folder rail: All inboxes, one row per mailbox that narrows the list on screen
 * to it (`?in=`) with a link that opens that mailbox on its own, then the
 * unified folders (All sent, All drafts, All archive, All spam, All trash),
 * each expandable to the same folder of every mailbox. The team inbox (owners
 * and admins) is a separate product with its own list, so it is a link out
 * rather than a filter.
 */
import {
	mailboxFolderHref,
	unifiedFolderHref,
	type UnifiedFolderRole,
} from '~/utils/postboxAllInboxes';
import type { InboxIdentity } from '~/utils/inboxIdentity';
import { navIcon } from '~/lib/navIcons';
import InboxChip from '~/components/inbox/InboxChip.vue';
import {
	ArchiveIcon,
	ArrowUpRightIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	FileEditIcon,
	InboxIcon,
	PaperPlaneIcon,
	RobotIcon,
	ShieldWarningIcon,
	TrashIcon,
	type IconComponent,
} from '@coolicons/vue';

const props = defineProps<{
	/** The unified folder on screen. */
	role: UnifiedFolderRole;
	inboxes: readonly InboxIdentity[];
	/** The mailbox the list is narrowed to, or null for every mailbox. */
	only: string | null;
	/** The provider the list is narrowed to, or null. */
	provider: string | null;
	/** The category filter, kept when switching inboxes. */
	category: string | null;
}>();

const { t } = useI18n();
const { isEnabled } = useFeatureFlag();
const { isAdmin } = usePermissions();
const showTeamInbox = computed(() => isAdmin.value && isEnabled('inbox'));

const ROW_CLASS = 'flex items-center gap-2 px-2.5 py-1 rounded text-sm min-w-0';

const FOLDERS: readonly { role: Exclude<UnifiedFolderRole, 'inbox'>; icon: IconComponent }[] = [
	{ role: 'sent', icon: PaperPlaneIcon },
	{ role: 'drafts', icon: FileEditIcon },
	{ role: 'archive', icon: ArchiveIcon },
	{ role: 'spam', icon: ShieldWarningIcon },
	{ role: 'trash', icon: TrashIcon },
];

const isInbox = computed(() => props.role === 'inbox');
const narrowed = computed(() => props.only !== null || props.provider !== null);

/** The folder on screen starts open, so its per-mailbox links are in reach. */
const expanded = ref(new Set<UnifiedFolderRole>([props.role]));
watch(
	() => props.role,
	(role) => {
		if (!expanded.value.has(role)) expanded.value = new Set([...expanded.value, role]);
	}
);
function toggle(role: UnifiedFolderRole) {
	const next = new Set(expanded.value);
	if (next.has(role)) next.delete(role);
	else next.add(role);
	expanded.value = next;
}

function folderLabel(role: UnifiedFolderRole): string {
	return t(`components.postbox.postboxFolderList.roles.${role}`);
}
</script>

<template>
	<aside class="w-56 p-3 flex flex-col gap-2 border-r border-border-subtle bg-bg-elevated">
		<NuxtLink
			:to="unifiedFolderHref('inbox', { provider, category })"
			:class="[ROW_CLASS, isInbox && !only ? 'bg-bg-surface text-brand' : 'hover:bg-bg-surface']"
			:aria-current="isInbox && !only ? 'page' : undefined"
			data-testid="all-inboxes-rail-all"
		>
			<component :is="navIcon(InboxIcon, isInbox && !only)" class="w-4 h-4 flex-shrink-0" />
			<span class="truncate">{{ t('components.postbox.allInboxes.title') }}</span>
		</NuxtLink>

		<div class="mt-3">
			<header class="mb-1 px-2">
				<span class="text-xs font-semibold uppercase tracking-wider text-text-tertiary">{{
					t('components.postbox.allInboxes.inboxesHeading')
				}}</span>
			</header>
			<ul class="flex flex-col gap-0.5">
				<li v-for="inbox in inboxes" :key="inbox.mailboxId" class="group flex items-center">
					<NuxtLink
						:to="unifiedFolderHref(role, { in: inbox.mailboxId, category })"
						:class="[
							ROW_CLASS,
							'flex-1',
							only === inbox.mailboxId ? 'bg-bg-surface text-brand' : 'hover:bg-bg-surface',
						]"
						:aria-current="only === inbox.mailboxId ? 'page' : undefined"
						data-testid="all-inboxes-rail-inbox"
					>
						<InboxChip
							:name="inbox.name"
							:slot="inbox.slot"
							:mark="inbox.mark"
							variant="plain"
							size="md"
						/>
						<span v-if="inbox.unread > 0" class="ml-auto text-xs tabular-nums text-text-tertiary">{{
							inbox.unread
						}}</span>
					</NuxtLink>
					<UiTooltip :text="t('components.postbox.allInboxes.openInbox', { name: inbox.name })">
						<NuxtLink
							:to="mailboxFolderHref(role, inbox.mailboxId)"
							class="p-1 rounded text-text-tertiary opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-text-primary"
							:aria-label="t('components.postbox.allInboxes.openInbox', { name: inbox.name })"
						>
							<ArrowUpRightIcon class="w-3.5 h-3.5" />
						</NuxtLink>
					</UiTooltip>
				</li>
			</ul>
		</div>

		<div class="mt-3">
			<header class="mb-1 px-2">
				<span class="text-xs font-semibold uppercase tracking-wider text-text-tertiary">{{
					t('components.postbox.allInboxes.foldersHeading')
				}}</span>
			</header>
			<ul class="flex flex-col gap-0.5">
				<li v-for="folder in FOLDERS" :key="folder.role">
					<div class="flex items-center">
						<NuxtLink
							:to="unifiedFolderHref(folder.role, { in: only, provider })"
							:class="[
								ROW_CLASS,
								'flex-1',
								role === folder.role ? 'bg-bg-surface text-brand' : 'hover:bg-bg-surface',
							]"
							:aria-current="role === folder.role && !narrowed ? 'page' : undefined"
							:data-testid="`all-inboxes-rail-${folder.role}`"
						>
							<component
								:is="navIcon(folder.icon, role === folder.role)"
								class="w-4 h-4 flex-shrink-0"
							/>
							<span class="truncate">{{
								t(`components.postbox.allInboxes.roles.${folder.role}`)
							}}</span>
						</NuxtLink>
						<button
							v-if="inboxes.length > 0"
							type="button"
							class="p-1 rounded text-text-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
							:aria-expanded="expanded.has(folder.role)"
							:aria-label="
								t(
									expanded.has(folder.role)
										? 'components.postbox.allInboxes.collapseFolder'
										: 'components.postbox.allInboxes.expandFolder',
									{ folder: folderLabel(folder.role) }
								)
							"
							@click="toggle(folder.role)"
						>
							<component
								:is="expanded.has(folder.role) ? ChevronDownIcon : ChevronRightIcon"
								class="w-3.5 h-3.5"
							/>
						</button>
					</div>
					<ul v-if="expanded.has(folder.role)" class="ml-6 mt-0.5 flex flex-col gap-0.5">
						<li v-for="inbox in inboxes" :key="inbox.mailboxId">
							<NuxtLink
								:to="mailboxFolderHref(folder.role, inbox.mailboxId)"
								:class="[ROW_CLASS, 'hover:bg-bg-surface text-text-secondary']"
								:aria-label="
									t('components.postbox.allInboxes.mailboxFolder', {
										folder: folderLabel(folder.role),
										name: inbox.name,
									})
								"
								data-testid="all-inboxes-rail-mailbox-folder"
							>
								<InboxChip
									:name="inbox.name"
									:slot="inbox.slot"
									:mark="inbox.mark"
									variant="plain"
								/>
							</NuxtLink>
						</li>
					</ul>
				</li>
			</ul>
		</div>

		<PostboxRailLink
			v-if="showTeamInbox"
			class="mt-3"
			to="/dashboard/inbox"
			:icon="RobotIcon"
			:label="t('components.shell.teamInbox')"
		/>
	</aside>
</template>
