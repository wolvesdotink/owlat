<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	emailId: Id<'transactionalEmails'> | null;
	emailName?: string;
}>();

const isOpen = defineModel<boolean>('open', { default: false });

const { data, isLoading } = useConvexQuery(api.transactional.sends.listByTransactionalEmail, () =>
	isOpen.value && props.emailId ? { transactionalEmailId: props.emailId, limit: 25 } : 'skip',
);

const sends = computed(() => data.value?.sends ?? []);

const statusStyles: Record<string, string> = {
	queued: 'bg-bg-surface text-text-secondary',
	sent: 'bg-info/10 text-info',
	delivered: 'bg-success/10 text-success',
	opened: 'bg-success/10 text-success',
	clicked: 'bg-success/10 text-success',
	failed: 'bg-error/10 text-error',
	bounced: 'bg-error/10 text-error',
	complained: 'bg-error/10 text-error',
};
</script>

<template>
	<UiModal v-model:open="isOpen" :title="`Recent sends${emailName ? ` — ${emailName}` : ''}`">
		<div v-if="isLoading" class="py-10 flex justify-center">
			<div class="w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
		</div>

		<p v-else-if="sends.length === 0" class="py-10 text-center text-sm text-text-tertiary">
			No sends yet — trigger this email via the API to see deliveries here.
		</p>

		<ul v-else class="divide-y divide-border-subtle -mx-2">
			<li v-for="send in sends" :key="send._id">
				<NuxtLink
					:to="`/dashboard/transactional/${emailId}/sends/${send._id}`"
					class="flex items-center justify-between gap-3 px-2 py-2.5 rounded hover:bg-bg-surface transition-colors"
					@click="isOpen = false"
				>
					<div class="min-w-0">
						<p class="text-sm text-text-primary truncate">
							{{ send.contact?.email ?? send.email ?? 'Unknown recipient' }}
						</p>
						<p class="text-xs text-text-tertiary mt-0.5">{{ formatDateTime(send.sentAt ?? send.queuedAt ?? send._creationTime) }}</p>
					</div>
					<span
						:class="[
							'inline-flex px-2 py-0.5 rounded text-xs font-medium capitalize flex-shrink-0',
							statusStyles[send.status] ?? 'bg-bg-surface text-text-secondary',
						]"
					>
						{{ send.status }}
					</span>
				</NuxtLink>
			</li>
		</ul>

		<p v-if="data?.hasMore" class="mt-3 text-xs text-text-tertiary text-center">
			Showing the 25 most recent sends.
		</p>
	</UiModal>
</template>
