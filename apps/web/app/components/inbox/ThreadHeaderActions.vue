<script setup lang="ts">
/**
 * The Team inbox thread header's actions. Reply is the one primary action; the
 * thread's state (assignee, snooze, status) and any chat channel already
 * discussing it sit beside it on wide screens, while starting a new discussion,
 * copying the thread's link and sharing it in chat wait in a ⋯ menu. Below `sm`
 * everything but Reply folds into that one menu instead of wrapping off the edge.
 *
 * The plain actions (discuss in chat, copy link, share in chat, auto-close
 * on / off, snooze / unsnooze) are described once in `simpleActions` and
 * rendered as buttons or menu items. Assignment and status have a richer wide
 * form (an avatar popover, a status menu) and a compact one (assign to me,
 * "mark as" items), so each gets both renderings here.
 *
 * Presentation only: the page owns the data and the writes.
 */
import type { AssignPopoverMember } from '~/components/inbox/AssignPopover.vue';
import { useShortcutLabels } from '~/composables/useShortcutLabels';
import {
	AlarmIcon,
	AlarmOffIcon,
	ChatCircleIcon,
	ChatCirclePlusIcon,
	CheckIcon,
	ChevronDownIcon,
	LinkIcon,
	MoreHorizontalIcon,
	ReplyIcon,
	ShareIcon,
	TimerIcon,
	UserMinusCornerIcon,
	UserPlusCornerIcon,
	type IconComponent,
} from '@coolicons/vue';

const THREAD_STATUSES = ['open', 'waiting', 'resolved'] as const;
type ThreadStatus = (typeof THREAD_STATUSES)[number];

const props = defineProps<{
	isAdmin: boolean;
	chatEnabled: boolean;
	discussionChannels: readonly { _id: string; name: string }[];
	members: AssignPopoverMember[];
	currentUserId: string | null;
	assignedTo: string | null;
	assignedMemberName: string | null;
	isSnoozed: boolean;
	currentStatus: ThreadStatus;
	/**
	 * This thread's auto-close switch (`utils/inboxAutoClose.ts`); `null` or
	 * absent hides it (the rule is off and the thread never opted out).
	 */
	autoClose?: 'on' | 'off' | null;
}>();

const emit = defineEmits<{
	reply: [];
	assign: [userId: string | undefined];
	newChannel: [];
	snooze: [];
	unsnooze: [];
	status: [status: ThreadStatus];
	copyLink: [];
	shareInChat: [];
	/** Turn auto-close off (`true`) or back on (`false`) for this thread. */
	autoClose: [isDisabled: boolean];
}>();

const { t } = useI18n();
const { ariaFor } = useShortcutLabels();

const assignMenuOpen = ref(false);
const statusMenuOpen = ref(false);
const moreMenuOpen = ref(false);

const assignedToMe = computed(
	() => !!props.currentUserId && props.assignedTo === props.currentUserId
);
function toggleAssignToMe() {
	emit('assign', assignedToMe.value ? undefined : (props.currentUserId ?? undefined));
}

interface SimpleAction {
	key: string;
	icon: IconComponent;
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
				icon: ChatCircleIcon,
				label: `#${channel.name}`,
				title: t('dashboard.inbox.detail.discussInChannelTitle', { channel: channel.name }),
				to: `/dashboard/chat/${channel._id}`,
				run: () => void navigateTo(`/dashboard/chat/${channel._id}`),
			});
		}
		if (props.discussionChannels.length === 0) {
			actions.push({
				key: 'new-channel',
				icon: ChatCirclePlusIcon,
				label: t('dashboard.inbox.detail.discussInChannel'),
				run: () => emit('newChannel'),
			});
		}
	}
	actions.push({
		key: 'copy-link',
		icon: LinkIcon,
		label: t('shared.conversationLink.copyLink'),
		run: () => emit('copyLink'),
	});
	if (props.chatEnabled) {
		actions.push({
			key: 'share-in-chat',
			icon: ShareIcon,
			label: t('shared.conversationLink.shareInChat'),
			run: () => emit('shareInChat'),
		});
	}
	if (props.isAdmin && props.autoClose) {
		const isOn = props.autoClose === 'on';
		actions.push({
			key: 'auto-close',
			icon: isOn ? AlarmOffIcon : TimerIcon,
			label: t(
				isOn
					? 'dashboard.inbox.detail.autoClose.turnOff'
					: 'dashboard.inbox.detail.autoClose.turnOn'
			),
			run: () => emit('autoClose', isOn),
		});
	}
	return actions;
});

/** Wide screens: the channel links stay in view; the rest waits in ⋯. */
const inlineActions = computed(() => simpleActions.value.filter((action) => action.to));
const overflowActions = computed(() => simpleActions.value.filter((action) => !action.to));
const wideMenuOpen = ref(false);

const snoozeAction = computed<SimpleAction>(() =>
	props.isSnoozed
		? {
				key: 'unsnooze',
				icon: AlarmOffIcon,
				label: t('dashboard.inbox.detail.unsnooze'),
				run: () => emit('unsnooze'),
			}
		: {
				key: 'snooze',
				icon: AlarmIcon,
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
			:aria-keyshortcuts="ariaFor('inbox.reply')"
			@click="emit('reply')"
		>
			<ReplyIcon class="w-4 h-4" />
			{{ t('dashboard.inbox.detail.reply') }}
		</UiButton>

		<div class="hidden sm:flex items-center gap-2">
			<UiTooltip v-for="action in inlineActions" :key="action.key" :text="action.title">
				<NuxtLink
					:to="action.to!"
					class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-brand-subtle text-text-primary hover:bg-brand-subtle/70 transition-colors"
				>
					<component :is="action.icon" class="w-3.5 h-3.5 text-brand" />
					{{ action.label }}
				</NuxtLink>
			</UiTooltip>
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
						<UserPlusCornerIcon v-else class="w-4 h-4" />
						<span class="max-w-[10rem] truncate">
							{{ assignedMemberName ?? t('dashboard.inbox.detail.assign') }}
						</span>
					</UiButton>
				</template>
			</InboxAssignPopover>
			<UiButton variant="secondary" size="sm" class="gap-1.5" @click="snoozeAction.run">
				<component :is="snoozeAction.icon" class="w-4 h-4" />
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
						:aria-label="
							t('dashboard.inbox.detail.changeStatusAria', {
								status: t(`dashboard.inbox.detail.statuses.${currentStatus}`),
							})
						"
					>
						{{ t(`dashboard.inbox.detail.statuses.${currentStatus}`) }}
						<template #iconRight>
							<ChevronDownIcon class="w-4 h-4 text-text-tertiary" />
						</template>
					</UiButton>
				</template>
				<UiDropdownMenuItem
					v-for="s in THREAD_STATUSES"
					:key="s"
					role="menuitemradio"
					:aria-checked="s === currentStatus"
					@click="emit('status', s)"
				>
					<span class="flex-1 truncate">{{ t(`dashboard.inbox.detail.statuses.${s}`) }}</span>
					<CheckIcon v-if="s === currentStatus" class="w-4 h-4 text-brand shrink-0" />
				</UiDropdownMenuItem>
			</UiDropdownMenu>
			<UiDropdownMenu v-model:open="wideMenuOpen" position="right">
				<template #trigger>
					<UiButton
						variant="ghost"
						size="sm"
						type="button"
						class="w-8 px-0"
						data-testid="thread-more-wide"
						:aria-label="t('dashboard.inbox.detail.moreActions')"
					>
						<MoreHorizontalIcon class="w-4 h-4" />
					</UiButton>
				</template>
				<UiDropdownMenuItem v-for="action in overflowActions" :key="action.key" @click="action.run">
					<component :is="action.icon" class="w-4 h-4 shrink-0" />
					<span class="flex-1 truncate">{{ action.label }}</span>
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
					<MoreHorizontalIcon class="w-4 h-4" />
				</UiButton>
			</template>
			<UiDropdownMenuItem v-for="action in simpleActions" :key="action.key" @click="action.run">
				<component :is="action.icon" class="w-4 h-4 shrink-0" />
				<span class="flex-1 truncate">{{ action.label }}</span>
			</UiDropdownMenuItem>
			<UiDropdownMenuItem v-if="isAdmin" @click="toggleAssignToMe">
				<component
					:is="assignedToMe ? UserMinusCornerIcon : UserPlusCornerIcon"
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
				<component :is="snoozeAction.icon" class="w-4 h-4 shrink-0" />
				<span class="flex-1 truncate">{{ snoozeAction.label }}</span>
			</UiDropdownMenuItem>
			<UiDropdownMenuItem
				v-for="s in THREAD_STATUSES"
				:key="s"
				role="menuitemradio"
				:aria-checked="s === currentStatus"
				@click="emit('status', s)"
			>
				<span class="flex-1 truncate">{{ t(`dashboard.inbox.detail.markAs.${s}`) }}</span>
				<CheckIcon v-if="s === currentStatus" class="w-4 h-4 text-brand shrink-0" />
			</UiDropdownMenuItem>
		</UiDropdownMenu>
	</div>
</template>
