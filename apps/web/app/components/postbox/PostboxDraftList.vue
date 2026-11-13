<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	usePostboxListNow,
	usePostboxThreadTimestamp,
} from '~/composables/postbox/usePostboxListClock';
import { useAnswerModeNav } from '~/composables/useAnswerMode';
import { draftPlainText } from '~/utils/postboxDraftText';
import { ClockIcon, FileEditIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';
import InboxChip from '~/components/inbox/InboxChip.vue';
import PostboxEmptyState from './PostboxEmptyState.vue';

/**
 * One mailbox's drafts (`mailboxId`), or All Drafts (`mailboxIds`): the live
 * drafts of several mailboxes merged last edited first, each wearing its inbox
 * chip and reopening in its own mailbox.
 */
const props = defineProps<{
	mailboxId?: Id<'mailboxes'>;
	mailboxIds?: readonly Id<'mailboxes'>[];
}>();

const { t } = useI18n();
// The list is its own row renderer: one minute clock for every draft's age.
const formatTimestamp = usePostboxThreadTimestamp(usePostboxListNow());

const composeNav = usePostboxComposeNav();

const single = useConvexQuery(api.mail.drafts.listForMailbox, () =>
	props.mailboxId ? { mailboxId: props.mailboxId } : 'skip'
);
const merged = useConvexQuery(api.mail.mailbox.allInboxes.listDrafts, () =>
	!props.mailboxId && props.mailboxIds && props.mailboxIds.length > 0
		? { mailboxIds: [...props.mailboxIds] }
		: 'skip'
);
const isMerged = computed(() => !props.mailboxId);
const drafts = computed(() => (isMerged.value ? merged.data.value : single.data.value) ?? []);
const isLoading = computed(() =>
	isMerged.value ? merged.isLoading.value : single.isLoading.value
);
// A failed read is not an empty folder: "No drafts" would say the work is gone.
const error = computed(() => (isMerged.value ? merged.error.value : single.error.value));
function retry() {
	if (isMerged.value) merged.refetch();
	else single.refetch();
}
const { byId: inboxById } = useInboxes();

// A reply draft is continued where replies are written (Answer mode, on the
// message it answers); a new email or a forward reopens on the compose page.
const answerNav = useAnswerModeNav();
function openDraft(draft: {
	_id: string;
	mailboxId: Id<'mailboxes'>;
	inReplyToMessageId?: string;
}) {
	if (draft.inReplyToMessageId) {
		void answerNav.open(draft.inReplyToMessageId, { draftId: draft._id });
		return;
	}
	void composeNav.open({ mailboxId: draft.mailboxId, draftId: draft._id as Id<'mailDrafts'> });
}

function preview(bodyHtml: string | undefined): string {
	return draftPlainText(bodyHtml ?? '').slice(0, 100);
}
</script>

<template>
	<div v-if="isLoading" class="p-6 flex justify-center">
		<SpinnerIcon class="w-5 h-5 text-text-tertiary" />
	</div>
	<div v-else-if="error && drafts.length === 0" class="p-4">
		<UiQueryBoundary :error="error" @retry="retry" />
	</div>
	<PostboxEmptyState
		v-else-if="drafts.length === 0"
		:icon="FileEditIcon"
		:title="t('components.postbox.postboxDraftList.empty')"
	/>
	<ul v-else class="divide-y divide-border-subtle">
		<li v-for="d in drafts" :key="d._id">
			<button
				type="button"
				class="w-full text-left block px-4 py-3 hover:bg-(--surface-1-hover)"
				@click="openDraft(d)"
			>
				<div class="flex items-baseline justify-between gap-3">
					<span class="truncate text-sm font-medium text-text-primary">
						{{
							d.toAddresses.length > 0
								? d.toAddresses.join(', ')
								: t('components.postbox.postboxDraftList.noRecipient')
						}}
					</span>
					<span class="text-xs text-text-tertiary flex-shrink-0">
						{{ formatTimestamp(d.lastEditedAt) }}
					</span>
				</div>
				<p
					v-if="d.state === 'scheduled' && d.scheduledSendAt"
					class="inline-flex items-center gap-1 mt-1 text-xs text-brand"
				>
					<ClockIcon class="w-3 h-3" />
					{{
						t('components.postbox.postboxDraftList.scheduled', {
							when: formatDateTime(d.scheduledSendAt),
						})
					}}
				</p>
				<p class="flex items-center gap-2 min-w-0 text-sm text-text-secondary mt-0.5">
					<InboxChip
						v-if="isMerged && inboxById.get(d.mailboxId)"
						:name="inboxById.get(d.mailboxId)!.name"
						:slot="inboxById.get(d.mailboxId)!.slot"
						:mark="inboxById.get(d.mailboxId)!.mark"
						variant="plain"
						class="flex-shrink-0"
					/>
					<span class="truncate">{{
						d.subject || t('components.postbox.postboxDraftList.noSubject')
					}}</span>
				</p>
				<p class="text-xs text-text-tertiary truncate mt-0.5">{{ preview(d.bodyHtml) }}</p>
			</button>
		</li>
	</ul>
</template>
