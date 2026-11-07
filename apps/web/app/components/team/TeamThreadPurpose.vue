<script setup lang="ts">
/**
 * The purpose header of a team thread (a Team Inbox thread, a shared-mailbox
 * conversation): the action the customer's emails ask of the team, in the
 * team view's words, never a personal fact or overview. "Open for the team"
 * until someone holds it. The full "Open for the team" list (TeamPinnedItems,
 * with Claim, Assign and the notes) is its "more", so nothing open is hidden
 * and the item verbs stay one click away.
 */
import type { Id } from '@owlat/api/dataModel';
import BriefPurposeHeader from '~/components/brief/BriefPurposeHeader.vue';
import type { TeamThread } from '~/composables/team/useTeamThread';
import { useTeamCite } from '~/composables/team/useTeamCite';
import { resolveThreadPurpose } from '~/utils/threadPurpose';
import TeamPinnedItems from './TeamPinnedItems.vue';

const props = withDefaults(
	defineProps<{
		team: TeamThread;
		/** Metadata under the sentence; null where the page already titles the thread. */
		subject?: string | null;
		messageCount?: number;
		/** Show a message through the host's own paging (the shared-mailbox reader). */
		citeMessage?: (messageId: string) => void;
		/** The host could not load the cited email. */
		citeUnreachable?: boolean;
		replyShortcut?: string;
		headingTag?: 'h1' | 'h2';
	}>(),
	{
		subject: null,
		messageCount: 0,
		citeMessage: undefined,
		citeUnreachable: false,
		replyShortcut: undefined,
		headingTag: 'h2',
	}
);

const emit = defineEmits<{ reply: [] }>();

const { t } = useI18n();
const { isEnabled } = useFeatureFlag();

const view = computed(() => props.team.openItems.value);
const purpose = computed(() =>
	resolveThreadPurpose({
		isAiOn: isEnabled('ai'),
		team: view.value ?? null,
		viewerId: props.team.viewerId.value,
	})
);
/** Any item at all, open or just closed: the list behind "more" has something to show. */
const hasList = computed(() => {
	const v = view.value;
	return !!v && v.forTeam.length + v.waitingOnOthers.length + v.unclear.length > 0;
});

const context = props.citeMessage
	? useTeamCite({
			stream: props.team.stream,
			view: props.team.openItems,
			memberName: props.team.memberName,
			citeMessage: () => props.citeMessage,
		})
	: props.team.cite;

const mailThreadId = computed(() => {
	const target = props.team.target.value;
	return target?.kind === 'mail' ? (target.id as Id<'mailThreads'>) : undefined;
});
const conversationThreadId = computed(() => {
	const target = props.team.target.value;
	return target?.kind === 'team' ? (target.id as Id<'conversationThreads'>) : undefined;
});
</script>

<template>
	<div>
		<BriefPurposeHeader
			:purpose="purpose"
			:subject="subject"
			:message-count="messageCount"
			:mail-thread-id="mailThreadId"
			:conversation-thread-id="conversationThreadId"
			:source-of="context.sourceOf"
			:cite="context.cite"
			:member-name="team.memberName"
			:reply-shortcut="replyShortcut"
			:heading-tag="headingTag"
			:pending="view === undefined && isEnabled('ai')"
			:always-offer-more="hasList"
			@reply="emit('reply')"
			@act="team.act"
		>
			<template #more>
				<TeamPinnedItems :team="team" :cite-message="citeMessage" start-open />
			</template>
		</BriefPurposeHeader>
		<p
			v-if="citeUnreachable"
			role="status"
			class="mt-2 rounded-lg bg-warning-subtle px-3 py-2 text-xs text-warning"
			data-testid="team-cite-unreachable"
		>
			{{ t('components.team.items.citeUnreachable') }}
		</p>
	</div>
</template>
