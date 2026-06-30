<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
}>();

const stack = usePostboxComposerStack();

const { data, isLoading } = useConvexQuery(api.mail.drafts.listForMailbox, () => ({
	mailboxId: props.mailboxId,
}));
const drafts = computed(() => data.value ?? []);

function openDraft(draftId: string) {
	stack.open({ mailboxId: props.mailboxId, draftId: draftId as Id<'mailDrafts'> });
}

function preview(bodyHtml: string | undefined): string {
	return (bodyHtml ?? '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 100);
}
</script>

<template>
	<div v-if="isLoading" class="p-6 flex justify-center">
		<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
	</div>
	<div v-else-if="drafts.length === 0" class="p-12 text-center">
		<Icon name="lucide:file-edit" class="w-10 h-10 mx-auto text-text-tertiary" />
		<p class="text-sm text-text-secondary mt-3">No drafts</p>
	</div>
	<ul v-else class="divide-y divide-border-subtle">
		<li v-for="d in drafts" :key="d._id">
			<button
				type="button"
				class="w-full text-left block px-4 py-3 hover:bg-bg-elevated"
				@click="openDraft(d._id)"
			>
				<div class="flex items-baseline justify-between gap-3">
					<span class="truncate text-sm font-medium text-text-primary">
						{{ d.toAddresses.length > 0 ? d.toAddresses.join(', ') : 'No recipient' }}
					</span>
					<span class="text-xs text-text-tertiary flex-shrink-0">
						{{ formatThreadTimestamp(d.lastEditedAt) }}
					</span>
				</div>
				<p
					v-if="d.state === 'scheduled' && d.scheduledSendAt"
					class="inline-flex items-center gap-1 mt-1 text-xs text-brand"
				>
					<Icon name="lucide:clock" class="w-3 h-3" />
					Scheduled {{ formatDateTime(d.scheduledSendAt) }}
				</p>
				<p class="truncate text-sm text-text-secondary mt-0.5">
					{{ d.subject || '(no subject)' }}
				</p>
				<p class="text-xs text-text-tertiary truncate mt-0.5">{{ preview(d.bodyHtml) }}</p>
			</button>
		</li>
	</ul>
</template>
