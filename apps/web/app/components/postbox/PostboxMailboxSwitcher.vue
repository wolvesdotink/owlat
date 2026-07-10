<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

// Sidebar mailbox switcher: the caller's personal mailbox(es) plus the shared
// (team) inboxes they belong to, each with its own unread badge. Sections,
// labels, and badges all come from `mail.mailbox.accessible` (one accessible +
// active truth), so read state is one shared truth per message — a team inbox's
// badge is identical for every member. Personal-only users with a single mailbox
// see nothing here — their sidebar is unchanged.
const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	collapsed: boolean;
}>();

const { sections, switchToMailbox } = usePostboxMailbox();

const personal = computed(() => sections.value.personal);
const team = computed(() => sections.value.team);

// Only render the personal switcher when there is a real choice (more than one
// personal mailbox, or at least one team inbox to switch back from). A lone
// personal mailbox keeps the sidebar exactly as it was.
const showPersonal = computed(() => personal.value.length > 1 || team.value.length > 0);
const showTeam = computed(() => team.value.length > 0);

// One descriptor per rendered section so the personal and team blocks share a
// single template (icon + heading + a title prefix are the only differences).
// Inferred (not annotated) so each item keeps its branded `mailboxId` for
// `switchTo`.
const sectionDescriptors = computed(() => [
	...(showPersonal.value
		? [{ key: 'personal', heading: 'Mailboxes', icon: 'lucide:mail', titlePrefix: '', items: personal.value }]
		: []),
	...(showTeam.value
		? [{ key: 'team', heading: 'Team', icon: 'lucide:users', titlePrefix: 'Team inbox: ', items: team.value }]
		: []),
]);

function switchTo(id: Id<'mailboxes'>) {
	if (id === props.mailboxId) return;
	switchToMailbox(id);
}
</script>

<template>
	<div v-if="sectionDescriptors.length > 0" class="flex flex-col gap-2">
		<div
			v-for="section in sectionDescriptors"
			:key="section.key"
			:class="collapsed ? 'flex flex-col items-center gap-1' : ''"
		>
			<span
				v-if="!collapsed"
				class="block px-2 mb-1 text-xs font-semibold uppercase tracking-wider text-text-tertiary"
				>{{ section.heading }}</span
			>
			<button
				v-for="mb in section.items"
				:key="mb.mailboxId"
				type="button"
				class="rounded text-sm hover:bg-bg-surface focus-visible:ring-1 focus-visible:ring-brand/40 outline-none"
				:class="[
					collapsed
						? 'relative flex items-center justify-center w-9 h-9'
						: 'flex items-center gap-2 px-2.5 py-1.5 w-full min-w-0',
					{ 'bg-bg-surface text-brand': mb.mailboxId === mailboxId },
				]"
				:title="collapsed ? `${section.titlePrefix}${mb.label}` : undefined"
				:aria-label="collapsed ? `${section.titlePrefix}${mb.label}` : undefined"
				:aria-current="mb.mailboxId === mailboxId ? 'true' : undefined"
				@click="switchTo(mb.mailboxId)"
			>
				<Icon :name="section.icon" class="w-4 h-4 flex-shrink-0" />
				<template v-if="!collapsed">
					<span class="flex-1 truncate text-left">{{ mb.label }}</span>
					<span
						v-if="mb.unread > 0"
						class="text-xs font-medium text-text-secondary flex-shrink-0"
						>{{ mb.unread }}</span
					>
				</template>
				<span
					v-else-if="mb.unread > 0"
					class="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-brand text-white text-[10px] leading-4 font-medium text-center"
					>{{ mb.unread > 99 ? '99+' : mb.unread }}</span
				>
			</button>
		</div>
	</div>
</template>
