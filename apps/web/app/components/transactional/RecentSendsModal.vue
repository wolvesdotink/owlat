<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const { t } = useI18n();

const props = defineProps<{
	emailId: Id<'transactionalEmails'> | null;
	emailName?: string;
}>();

const isOpen = defineModel<boolean>('open', { default: false });

const { data, isLoading } = useConvexQuery(api.transactional.sends.listByTransactionalEmail, () =>
	isOpen.value && props.emailId ? { transactionalEmailId: props.emailId, limit: 25 } : 'skip'
);

const sends = computed(() => data.value?.sends ?? []);

/**
 * Translated pill text. A status outside the map keeps the old behaviour — the
 * raw value, capitalized by CSS — rather than painting a missing message path.
 */
const STATUS_LABEL_KEYS: Record<string, string> = {
	queued: 'components.transactional.recentSendsModal.status.queued',
	sent: 'components.transactional.recentSendsModal.status.sent',
	delivered: 'components.transactional.recentSendsModal.status.delivered',
	opened: 'components.transactional.recentSendsModal.status.opened',
	clicked: 'components.transactional.recentSendsModal.status.clicked',
	failed: 'components.transactional.recentSendsModal.status.failed',
	bounced: 'components.transactional.recentSendsModal.status.bounced',
	complained: 'components.transactional.recentSendsModal.status.complained',
};

function statusLabel(status: string): string {
	const key = STATUS_LABEL_KEYS[status];
	return key ? t(key) : status;
}

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
	<UiModal
		v-model:open="isOpen"
		:title="emailName ? t('components.transactional.recentSendsModal.titleNamed', { name: emailName }) : t('components.transactional.recentSendsModal.title')"
	>
		<div v-if="isLoading" class="py-10 flex justify-center">
			<UiSpinner size="md" />
		</div>

		<p v-else-if="sends.length === 0" class="py-10 text-center text-sm text-text-tertiary">
			{{ t('components.transactional.recentSendsModal.noSends') }}
		</p>

		<ul v-else class="divide-y divide-border-subtle -mx-2">
			<li v-for="send in sends" :key="send._id">
				<NuxtLink
					:to="`/dashboard/send/transactional/${emailId}/sends/${send._id}`"
					class="flex items-center justify-between gap-3 px-2 py-2.5 rounded hover:bg-bg-surface transition-colors"
					@click="isOpen = false"
				>
					<div class="min-w-0">
						<p class="text-sm text-text-primary truncate">
							{{ send.contact?.email ?? send.email ?? t('components.transactional.recentSendsModal.unknownRecipient') }}
						</p>
						<p class="text-xs text-text-tertiary mt-0.5">
							{{ formatDateTime(send.sentAt ?? send.queuedAt ?? send._creationTime) }}
						</p>
					</div>
					<span
						:class="[
							'inline-flex px-2 py-0.5 rounded text-xs font-medium capitalize flex-shrink-0',
							statusStyles[send.status] ?? 'bg-bg-surface text-text-secondary',
						]"
					>
						{{ statusLabel(send.status) }}
					</span>
				</NuxtLink>
			</li>
		</ul>

		<p v-if="data?.hasMore" class="mt-3 text-xs text-text-tertiary text-center">
			{{ t('components.transactional.recentSendsModal.hasMore') }}
		</p>
	</UiModal>
</template>
