<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

/**
 * The mailbox identity chip: which mailbox you are reading, and the menu that
 * switches it.
 *
 * This used to be a stacked section at the top of the rail — two headings and a
 * full-width row per mailbox, each with its own unread badge — costing the rail
 * its first ~120px before the first folder. It is now a chip beside Compose;
 * the per-mailbox unread badges moved into the menu, where you are already
 * looking when you choose. Sections, labels and badges still come from
 * `mail.mailbox.queries.accessible` (one accessible + active truth), so a team
 * inbox's badge is identical for every member.
 *
 * Personal-only users with a single mailbox still see nothing at all — there is
 * no choice to offer, so there is no chip.
 */
const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	/** Rail is the narrow icon strip: the chip shrinks to its glyph. */
	collapsed: boolean;
}>();

const { t } = useI18n();

const { sections, switchToMailbox } = usePostboxMailbox();

const personal = computed(() => sections.value.personal);
const team = computed(() => sections.value.team);

// Only render when there is a real choice (more than one personal mailbox, or
// at least one team inbox to switch back from).
const hasChoice = computed(() => personal.value.length > 1 || team.value.length > 0);

// One descriptor per rendered section so the personal and team blocks share a
// single template. Inferred (not annotated) so each item keeps its branded
// `mailboxId` for `switchTo`.
const sectionDescriptors = computed(() => [
	{
		key: 'personal',
		heading: t('components.postbox.postboxMailboxSwitcher.personal.heading'),
		icon: 'lucide:mail',
		items: personal.value,
	},
	{
		key: 'team',
		heading: t('components.postbox.postboxMailboxSwitcher.team.heading'),
		icon: 'lucide:users',
		items: team.value,
	},
]);

const active = computed(() =>
	[...personal.value, ...team.value].find((mb) => mb.mailboxId === props.mailboxId)
);

/** Unread sitting in the mailboxes you are NOT reading — the chip's only badge. */
const elsewhereUnread = computed(() =>
	[...personal.value, ...team.value]
		.filter((mb) => mb.mailboxId !== props.mailboxId)
		.reduce((total, mb) => total + mb.unread, 0)
);

const chipLabel = computed(
	() => active.value?.label ?? t('components.postbox.postboxMailboxSwitcher.fallbackLabel')
);

const open = ref(false);

function switchTo(id: Id<'mailboxes'>) {
	open.value = false;
	if (id === props.mailboxId) return;
	switchToMailbox(id);
}
</script>

<template>
	<!-- `self-start max-w-full`: the chip is as wide as its name and no wider, and
	     truncates rather than widening the rail when the name is long. -->
	<UiDropdownMenu
		v-if="hasChoice"
		v-model:open="open"
		position="left"
		class="self-start max-w-full"
	>
		<template #trigger>
			<button
				type="button"
				class="relative rounded-full text-text-secondary hover:text-text-primary hover:bg-bg-surface focus-visible:ring-1 focus-visible:ring-brand/40 outline-none"
				:class="
					collapsed
						? 'flex items-center justify-center w-9 h-9'
						: 'flex items-center gap-1 pl-2 pr-1.5 py-0.5 max-w-full min-w-0'
				"
				:title="t('components.postbox.postboxMailboxSwitcher.switchTitle', { label: chipLabel })"
				:aria-label="
					t('components.postbox.postboxMailboxSwitcher.switchTitle', { label: chipLabel })
				"
			>
				<Icon name="lucide:mail" class="w-4 h-4 flex-shrink-0" />
				<template v-if="!collapsed">
					<span class="text-xs truncate">{{ chipLabel }}</span>
					<Icon name="lucide:chevron-down" class="w-3 h-3 flex-shrink-0" />
				</template>
				<!-- Unread waiting in the OTHER mailboxes. The current mailbox's own
				     counts are already on the folder rows below. -->
				<span
					v-if="elsewhereUnread > 0"
					class="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-brand"
				/>
			</button>
		</template>

		<template v-for="section in sectionDescriptors" :key="section.key">
			<template v-if="section.items.length > 0">
				<p class="px-3 pt-2 pb-1 text-2xs font-semibold uppercase tracking-wider text-text-tertiary">
					{{ section.heading }}
				</p>
				<UiDropdownMenuItem
					v-for="mb in section.items"
					:key="mb.mailboxId"
					:icon="section.icon"
					@click="switchTo(mb.mailboxId)"
				>
					<span class="flex-1 truncate text-left" :class="{ 'text-brand': mb.mailboxId === mailboxId }">
						{{ mb.label }}
					</span>
					<span v-if="mb.unread > 0" class="text-xs font-medium text-text-secondary">{{
						mb.unread > 99 ? '99+' : mb.unread
					}}</span>
				</UiDropdownMenuItem>
			</template>
		</template>
	</UiDropdownMenu>
</template>
