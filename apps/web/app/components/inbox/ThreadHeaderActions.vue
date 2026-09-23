<script setup lang="ts">
/**
 * The Team inbox thread header's actions. Reply is the one primary action; the
 * rest sit beside it on wide screens and fold into one ⋯ menu below `sm`
 * instead of wrapping off the edge.
 *
 * The plain actions (discuss in chat, snooze / unsnooze) are described once in
 * `simpleActions` and rendered as buttons or menu items. Assignment and status
 * have a richer wide form (an avatar popover, a status menu) and a compact one
 * (assign to me, "mark as" items), so each gets both renderings here.
 *
 * Presentation only: the page owns the data and the writes.
 */
const THREAD_STATUSES = ['open', 'waiting', 'resolved'] as const;
type ThreadStatus = (typeof THREAD_STATUSES)[number];

const props = defineProps<{
	isAdmin: boolean;
	chatEnabled: boolean;
	discussionChannels: readonly { _id: string; name: string }[];
	members: readonly { userId: string; name?: string | null; email?: string | null; image?: string | null }[];
	currentUserId: string | null;
	assignedTo: string | null;
	assignedMemberName: string | null;
	isSnoozed: boolean;
	currentStatus: ThreadStatus;
}>();

const emit = defineEmits<{
	reply: [];
	assign: [userId: string | undefined];
	newChannel: [];
	snooze: [];
	unsnooze: [];
	status: [status: ThreadStatus];
}>();

const { t } = useI18n();

const assignMenuOpen = ref(false);
const statusMenuOpen = ref(false);
const moreMenuOpen = ref(false);

const assignedToMe = computed(() => !!props.currentUserId && props.assignedTo === props.currentUserId);
function toggleAssignToMe() {
	emit('assign', assignedToMe.value ? undefined : (props.currentUserId ?? undefined));
}

interface SimpleAction {
	key: string;
	icon: string;
	label: string;
	title?: string;
	/** A chat channel: a brand-tinted link on wide screens, not a button. */
	to?: string;
	run: () => void;
}

const simpleActions = computed<SimpleAction[]>(() => {
	const actions: SimpleAction[] = [];
	if (props.chatEnabled) {
		for (const channel of props.discussionChannels) {
			actions.push({
				key: `channel:${channel._id}`,
				icon: 'lucide:message-circle',
				label: `#${channel.name}`,
				title: t('dashboard.inbox.detail.discussInChannelTitle', { channel: channel.name }),
				to: `/dashboard/chat/${channel._id}`,
				run: () => void navigateTo(`/dashboard/chat/${channel._id}`),
			});
		}
		if (props.discussionChannels.length === 0) {
			actions.push({
				key: 'new-channel',
				icon: 'lucide:message-circle-plus',
				label: t('dashboard.inbox.detail.discussInChannel'),
				run: () => emit('newChannel'),
			});
		}
	}
	return actions;
});

const snoozeAction = computed<SimpleAction>(() =>
	props.isSnoozed
		? {
				key: 'unsnooze',
				icon: 'lucide:alarm-clock-off',
				label: t('dashboard.inbox.detail.unsnooze'),
				run: () => emit('unsnooze'),
			}
		: {
				key: 'snooze',
				icon: 'lucide:alarm-clock',
				label: t('dashboard.inbox.detail.snooze'),
				run: () => emit('snooze'),
			}
);
</script>

<template>
	<div class="flex shrink-0 items-center gap-2">
		<UiButton
			v-if="isAdmin"
			size="sm"
			class="gap-1.5"
			data-testid="thread-reply"
			:aria-keyshortcuts="'r'"
			@click="emit('reply')"
		>
			<Icon name="lucide:reply" class="w-4 h-4" />
			{{ t('dashboard.inbox.detail.reply') }}
		</UiButton>

		<div class="hidden sm:flex items-center gap-2">
			<template v-for="action in simpleActions" :key="action.key">
				<NuxtLink
					v-if="action.to"
					:to="action.to"
					class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-brand-subtle text-brand hover:bg-brand-subtle/70 transition-colors"
					:title="action.title"
				>
					<Icon :name="action.icon" class="w-3.5 h-3.5" />
					{{ action.label }}
				</NuxtLink>
				<UiButton v-else variant="outline" size="sm" @click="action.run">
					<template #iconLeft><Icon :name="action.icon" class="w-3.5 h-3.5" /></template>
					{{ action.label }}
				</UiButton>
			</template>
			<!-- Assignee picker — avatar popover (Me / members / Unassign). `open`
			     is a controlled prop: without the binding the popover never opens. -->
			<InboxAssignPopover
				v-model:open="assignMenuOpen"
				:members="members"
				:current-user-id="currentUserId"
				:assigned-to="assignedTo"
				position="right"
				@assign="(userId: string | undefined) => emit('assign', userId)"
			>
				<template #trigger>
					<UiButton
						variant="secondary"
						size="sm"
						type="button"
						class="gap-1.5"
						:aria-label="
							assignedMemberName
								? t('dashboard.inbox.detail.assignedToAria', { name: assignedMemberName })
								: t('dashboard.inbox.detail.assignThreadAria')
						"
					>
						<UiAvatar
							v-if="assignedTo"
							:name="assignedMemberName ?? undefined"
							deterministic-color
							size="sm"
						/>
						<Icon v-else name="lucide:user-plus" class="w-4 h-4" />
						<span class="max-w-[10rem] truncate">
							{{ assignedMemberName ?? t('dashboard.inbox.detail.assign') }}
						</span>
					</UiButton>
				</template>
			</InboxAssignPopover>
			<UiButton variant="secondary" size="sm" class="gap-1.5" @click="snoozeAction.run">
				<Icon :name="snoozeAction.icon" class="w-4 h-4" />
				{{ snoozeAction.label }}
			</UiButton>
			<!-- The ONE status control. The agent's processing state is a hint on
			     the reply composer, not a second status. -->
			<UiDropdownMenu v-model:open="statusMenuOpen" position="right">
				<template #trigger>
					<UiButton
						variant="secondary"
						size="sm"
						type="button"
						class="gap-1.5"
						data-testid="thread-status"
						:aria-label="t('dashboard.inbox.detail.changeStatusAria')"
					>
						{{ t(`dashboard.inbox.detail.statuses.${currentStatus}`) }}
						<template #iconRight>
							<Icon name="lucide:chevron-down" class="w-4 h-4 text-text-tertiary" />
						</template>
					</UiButton>
				</template>
				<UiDropdownMenuItem v-for="s in THREAD_STATUSES" :key="s" @click="emit('status', s)">
					<span class="flex-1 truncate">{{ t(`dashboard.inbox.detail.statuses.${s}`) }}</span>
					<Icon v-if="s === currentStatus" name="lucide:check" class="w-4 h-4 text-brand shrink-0" />
				</UiDropdownMenuItem>
			</UiDropdownMenu>
		</div>

		<!-- Narrow screens: everything but Reply in one menu. -->
		<UiDropdownMenu v-model:open="moreMenuOpen" position="right" class="sm:hidden">
			<template #trigger>
				<UiButton
					variant="secondary"
					size="sm"
					type="button"
					data-testid="thread-more"
					:aria-label="t('dashboard.inbox.detail.moreActions')"
				>
					<Icon name="lucide:ellipsis" class="w-4 h-4" />
				</UiButton>
			</template>
			<UiDropdownMenuItem v-for="action in simpleActions" :key="action.key" @click="action.run">
				<Icon :name="action.icon" class="w-4 h-4 shrink-0" />
				<span class="flex-1 truncate">{{ action.label }}</span>
			</UiDropdownMenuItem>
			<UiDropdownMenuItem v-if="isAdmin" @click="toggleAssignToMe">
				<Icon
					:name="assignedToMe ? 'lucide:user-minus' : 'lucide:user-plus'"
					class="w-4 h-4 shrink-0"
				/>
				<span class="flex-1 truncate">
					{{
						assignedToMe
							? t('dashboard.inbox.detail.unassignMe')
							: t('dashboard.inbox.detail.assignToMe')
					}}
				</span>
			</UiDropdownMenuItem>
			<UiDropdownMenuItem @click="snoozeAction.run">
				<Icon :name="snoozeAction.icon" class="w-4 h-4 shrink-0" />
				<span class="flex-1 truncate">{{ snoozeAction.label }}</span>
			</UiDropdownMenuItem>
			<UiDropdownMenuItem v-for="s in THREAD_STATUSES" :key="s" @click="emit('status', s)">
				<span class="flex-1 truncate">{{ t(`dashboard.inbox.detail.markAs.${s}`) }}</span>
				<Icon v-if="s === currentStatus" name="lucide:check" class="w-4 h-4 text-brand shrink-0" />
			</UiDropdownMenuItem>
		</UiDropdownMenu>
	</div>
</template>
