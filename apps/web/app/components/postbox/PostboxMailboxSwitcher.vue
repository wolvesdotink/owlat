<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { mailboxLabel } from '~/utils/postboxMailboxSections';

// Sidebar mailbox switcher: the caller's personal mailbox(es) plus the shared
// (team) inboxes they belong to, each with its own unread badge. Read state is
// one shared truth per message, so a team inbox's badge is identical for every
// member. Personal-only users with a single mailbox see nothing here — their
// sidebar is unchanged.
const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	collapsed: boolean;
}>();

const { sections, setCurrentMailbox } = usePostboxMailbox();

// Per-accessible-mailbox inbox unread → a lookup for the badges. Reactive: a
// teammate reading a shared message drops the shared badge for everyone.
const { data: unreadRows } = useConvexQuery(api.mail.mailbox.unreadByMailbox, () => ({}));
const unreadFor = (id: Id<'mailboxes'>): number =>
	unreadRows.value?.find((r) => r.mailboxId === id)?.unread ?? 0;

const personal = computed(() => sections.value.personal);
const team = computed(() => sections.value.team);

// Only render a personal switcher when there is a real choice (more than one
// personal mailbox, or at least one team inbox to switch back from). A lone
// personal mailbox keeps the sidebar exactly as it was.
const showPersonal = computed(() => personal.value.length > 1 || team.value.length > 0);
const showTeam = computed(() => team.value.length > 0);

function switchTo(id: Id<'mailboxes'>) {
	if (id === props.mailboxId) return;
	setCurrentMailbox(id);
	// Land on the switched mailbox's inbox rather than a folder/message id that
	// only exists in the previous mailbox.
	void navigateTo('/dashboard/postbox/inbox');
}
</script>

<template>
	<div v-if="showPersonal || showTeam" class="flex flex-col gap-2">
		<!-- Personal mailboxes -->
		<div v-if="showPersonal" :class="collapsed ? 'flex flex-col items-center gap-1' : ''">
			<span
				v-if="!collapsed"
				class="block px-2 mb-1 text-xs font-semibold uppercase tracking-wider text-text-tertiary"
				>Mailboxes</span
			>
			<button
				v-for="mb in personal"
				:key="mb._id"
				type="button"
				class="rounded text-sm hover:bg-bg-surface focus-visible:ring-1 focus-visible:ring-brand/40 outline-none"
				:class="[
					collapsed
						? 'relative flex items-center justify-center w-9 h-9'
						: 'flex items-center gap-2 px-2.5 py-1.5 w-full min-w-0',
					{ 'bg-bg-surface text-brand': mb._id === mailboxId },
				]"
				:title="collapsed ? mailboxLabel(mb) : undefined"
				:aria-label="collapsed ? mailboxLabel(mb) : undefined"
				:aria-current="mb._id === mailboxId ? 'true' : undefined"
				@click="switchTo(mb._id)"
			>
				<Icon name="lucide:mail" class="w-4 h-4 flex-shrink-0" />
				<template v-if="!collapsed">
					<span class="flex-1 truncate text-left">{{ mailboxLabel(mb) }}</span>
					<span
						v-if="unreadFor(mb._id) > 0"
						class="text-xs font-medium text-text-secondary flex-shrink-0"
						>{{ unreadFor(mb._id) }}</span
					>
				</template>
				<span
					v-else-if="unreadFor(mb._id) > 0"
					class="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-brand text-white text-[10px] leading-4 font-medium text-center"
					>{{ unreadFor(mb._id) > 99 ? '99+' : unreadFor(mb._id) }}</span
				>
			</button>
		</div>

		<!-- Shared (team) inboxes -->
		<div v-if="showTeam" :class="collapsed ? 'flex flex-col items-center gap-1' : ''">
			<span
				v-if="!collapsed"
				class="block px-2 mb-1 text-xs font-semibold uppercase tracking-wider text-text-tertiary"
				>Team</span
			>
			<button
				v-for="mb in team"
				:key="mb._id"
				type="button"
				class="rounded text-sm hover:bg-bg-surface focus-visible:ring-1 focus-visible:ring-brand/40 outline-none"
				:class="[
					collapsed
						? 'relative flex items-center justify-center w-9 h-9'
						: 'flex items-center gap-2 px-2.5 py-1.5 w-full min-w-0',
					{ 'bg-bg-surface text-brand': mb._id === mailboxId },
				]"
				:title="collapsed ? `Team inbox: ${mailboxLabel(mb)}` : undefined"
				:aria-label="collapsed ? `Team inbox: ${mailboxLabel(mb)}` : undefined"
				:aria-current="mb._id === mailboxId ? 'true' : undefined"
				@click="switchTo(mb._id)"
			>
				<Icon name="lucide:users" class="w-4 h-4 flex-shrink-0" />
				<template v-if="!collapsed">
					<span class="flex-1 truncate text-left">{{ mailboxLabel(mb) }}</span>
					<span
						v-if="unreadFor(mb._id) > 0"
						class="text-xs font-medium text-text-secondary flex-shrink-0"
						>{{ unreadFor(mb._id) }}</span
					>
				</template>
				<span
					v-else-if="unreadFor(mb._id) > 0"
					class="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-brand text-white text-[10px] leading-4 font-medium text-center"
					>{{ unreadFor(mb._id) > 99 ? '99+' : unreadFor(mb._id) }}</span
				>
			</button>
		</div>
	</div>
</template>
