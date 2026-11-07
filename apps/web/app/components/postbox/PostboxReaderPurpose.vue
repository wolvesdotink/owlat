<script setup lang="ts">
/**
 * What the open conversation is for, in the reader's header line (the
 * subject's place): BriefPurposeHeader fed from the personal brief
 * (`usePostboxReaderBrief().purpose`), or, for a shared mailbox, from the
 * team view (TeamThreadPurpose), which shows actions only.
 *
 * Under it, while the pane is too narrow for the company rail (`pbx-pane`
 * under 54rem, PostboxContextRail), the company context as one line that
 * opens in place. A host with no such pane (the Today overlay, a search
 * preview) has no rail, so the line always shows there.
 *
 * Got it on an update records the visit, as the Workbench's Got it does for a
 * Postbox thread, so the thread stops asking to be looked at.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { BriefItemView } from '../../../../api/convex/mail/interpret/briefShape';
import BriefPurposeHeader from '~/components/brief/BriefPurposeHeader.vue';
import CompanyContextDisclosure from '~/components/companies/CompanyContextDisclosure.vue';
import TeamThreadPurpose from '~/components/team/TeamThreadPurpose.vue';
import type { TeamItemAction } from '~/components/team/TeamOpenItem.vue';
import type { PostboxReaderBrief } from '~/composables/postbox/usePostboxReaderBrief';
import type { PostboxTeamStream } from '~/composables/postbox/usePostboxTeamStream';

const props = defineProps<{
	brief: PostboxReaderBrief;
	team: PostboxTeamStream;
	subject?: string;
	messageCount: number;
	/** The mail thread, once the reader knows it. */
	threadId?: string;
}>();

const emit = defineEmits<{ reply: [] }>();

const { t } = useI18n();
const { isEnabled } = useFeatureFlag();

const mailThreadId = computed(() => props.threadId as Id<'mailThreads'> | undefined);
const isPending = computed(
	() => props.brief.brief.value === undefined && isEnabled('ai') && props.brief.isBriefShown.value
);

const recordVisit = useBackendOperation(api.mail.threadVisits.recordVisit, {
	label: () => t('components.brief.purpose.operation'),
	announce: false,
});
/** The thread and brief revision Got it was given for. */
const acknowledgedFor = ref<string | null>(null);
const revisionKey = computed(
	() => `${props.threadId ?? ''}:${props.brief.brief.value?.interpretationRevision ?? ''}`
);
async function gotIt() {
	const id = mailThreadId.value;
	if (!id) return;
	const key = revisionKey.value;
	acknowledgedFor.value = key;
	const result = await recordVisit.run({ threadId: id });
	if (!result.ok && acknowledgedFor.value === key) acknowledgedFor.value = null;
}

function act(item: BriefItemView, action: TeamItemAction) {
	// Claim is a team verb; a personal mailbox never offers it.
	if (action !== 'claim') void props.brief.react(item, action);
}
</script>

<template>
	<div>
		<TeamThreadPurpose
			v-if="team.isActive.value"
			:team="team.team"
			:subject="subject ?? ''"
			:message-count="messageCount"
			:cite-message="brief.citeMessage"
			:cite-unreachable="brief.messageCiteState.value === 'unreachable'"
			reply-shortcut="postbox.reply"
			heading-tag="h1"
			@reply="emit('reply')"
		/>
		<BriefPurposeHeader
			v-else
			:purpose="brief.purpose.value"
			:subject="subject ?? ''"
			:message-count="messageCount"
			:mail-thread-id="mailThreadId"
			:source-of="brief.sourceOf"
			:cite="brief.openCite"
			reply-shortcut="postbox.reply"
			heading-tag="h1"
			:pending="isPending"
			:acknowledged="acknowledgedFor === revisionKey"
			@reply="emit('reply')"
			@act="act"
			@got-it="gotIt"
		/>
		<CompanyContextDisclosure
			v-if="mailThreadId"
			class="mt-3 @min-[54rem]/pbx-pane:hidden"
			:mail-thread-id="mailThreadId"
		/>
	</div>
</template>
