<script setup lang="ts">
import { useShortcutLabels } from '~/composables/useShortcutLabels';

/**
 * Avatar-based assignee picker for a Team Inbox thread — the shared control the
 * thread header, the Details card, and each list row's hover cluster all mount.
 *
 * Rows, in order: "Me" first (with the assign-to-me key of the surface it is
 * on, as the person has it bound), then the other org members, then Unassign. The current
 * assignee carries a check. The component owns none of the mutation: it just
 * emits the chosen assignee (a user id, or `undefined` to unassign) and lets the
 * caller route it through `inbox.mutations.assignThread`.
 *
 * Built on the shared UiDropdownMenu (teleported, keyboard-navigable, motion on
 * the moderate tier) + UiAvatar. The trigger is a passthrough slot so each host
 * supplies its own affordance.
 */
export interface AssignPopoverMember {
	userId: string;
	name?: string | null;
	email: string;
	image?: string | null;
}

const props = withDefaults(
	defineProps<{
		members: AssignPopoverMember[];
		/** Current viewer's user id — drives the "Me" row and its active state. */
		currentUserId?: string | null;
		/** Currently-assigned user id (null/undefined = unassigned). */
		assignedTo?: string | null;
		/** Controlled open state (optional; the menu self-manages otherwise). */
		open?: boolean;
		/** Menu alignment relative to the trigger. */
		position?: 'left' | 'right';
		/** The catalog id whose key the "Me" row hints: the thread's, or the list's. */
		assignShortcutId?: 'inbox.assignToMe' | 'inboxList.assignToMe';
	}>(),
	{
		currentUserId: null,
		assignedTo: null,
		open: false,
		position: 'right',
		assignShortcutId: 'inbox.assignToMe',
	}
);

const emit = defineEmits<{
	/** Chosen assignee — a user id, or `undefined` to unassign. */
	assign: [assignedTo: string | undefined];
	'update:open': [value: boolean];
}>();

const { t } = useI18n();
const { labelFor } = useShortcutLabels();
const assignKey = computed(() => labelFor(props.assignShortcutId));

const isOpen = computed({
	get: () => props.open,
	set: (v: boolean) => emit('update:open', v),
});

/** The viewer, resolved against the member directory for name/email/image. */
const me = computed<AssignPopoverMember | null>(() => {
	const id = props.currentUserId;
	if (!id) return null;
	return props.members.find((m) => m.userId === id) ?? { userId: id, email: '' };
});

/** Every member except the viewer — the viewer already has the dedicated "Me" row. */
const others = computed(() => props.members.filter((m) => m.userId !== props.currentUserId));

function memberLabel(m: AssignPopoverMember): string {
	return m.name?.trim() || m.email || t('components.inbox.assignPopover.teammate');
}

function choose(assignedTo: string | undefined) {
	emit('assign', assignedTo);
}
</script>

<template>
	<UiDropdownMenu v-model:open="isOpen" :position="position">
		<template #trigger>
			<slot name="trigger" :open="isOpen" />
		</template>

		<!-- Me first, with its shortcut hint. -->
		<UiDropdownMenuItem v-if="me" @click="choose(me.userId)">
			<UiAvatar
				:name="me.name ?? undefined"
				:email="me.email || undefined"
				:image="me.image ?? undefined"
				deterministic-color
				size="sm"
			/>
			<span class="flex-1 truncate">{{ t('components.inbox.assignPopover.assignToMe') }}</span>
			<kbd
				v-if="assignKey"
				class="ml-auto text-[10px] text-text-tertiary border border-border-subtle rounded px-1 py-0.5 leading-none"
			>
				{{ assignKey }}
			</kbd>
			<Icon
				v-if="assignedTo && assignedTo === me.userId"
				name="lucide:check"
				class="w-4 h-4 text-brand shrink-0"
			/>
		</UiDropdownMenuItem>

		<UiDropdownDivider v-if="me && others.length > 0" />

		<!-- Other members. -->
		<UiDropdownMenuItem v-for="m in others" :key="m.userId" @click="choose(m.userId)">
			<UiAvatar
				:name="m.name ?? undefined"
				:email="m.email || undefined"
				:image="m.image ?? undefined"
				deterministic-color
				size="sm"
			/>
			<span class="flex-1 truncate">{{ memberLabel(m) }}</span>
			<Icon
				v-if="assignedTo === m.userId"
				name="lucide:check"
				class="w-4 h-4 text-brand shrink-0"
			/>
		</UiDropdownMenuItem>

		<!-- Unassign — only offered when the thread is currently assigned. -->
		<template v-if="assignedTo">
			<UiDropdownDivider />
			<UiDropdownMenuItem icon="lucide:user-x" @click="choose(undefined)">
				{{ t('components.inbox.assignPopover.unassign') }}
			</UiDropdownMenuItem>
		</template>
	</UiDropdownMenu>
</template>
