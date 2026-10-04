<script setup lang="ts">
/**
 * A failed Team inbox message on the thread page: why it failed, and a Retry
 * that says what it will do (#1220). A failed send of a reply a person approved
 * is sent again and shows the text that will go out; a person's reply goes
 * back to review; only a message nobody touched has the agent draft again.
 */
import type { InboxRetryFacts } from '@owlat/shared/inboxRetry';
import { inboxRetryCopy } from '~/utils/inboxRetry';

const props = defineProps<{
	message: InboxRetryFacts & { errorMessage?: string };
	retrying: boolean;
}>();

const emit = defineEmits<{ retry: [] }>();

const { t } = useI18n();

const copy = computed(() => inboxRetryCopy(props.message));
</script>

<template>
	<div class="mt-4 p-3 bg-error-subtle rounded-lg" data-testid="thread-failed-retry">
		<p class="text-xs text-error font-medium mb-2">{{ t(copy.title) }}</p>
		<p v-if="message.errorMessage" class="text-sm text-text-primary break-words mb-3">
			{{ message.errorMessage }}
		</p>
		<p v-else class="text-sm text-text-secondary mb-3">
			{{ t('dashboard.inbox.detail.noErrorDetail') }}
		</p>
		<!-- The person's reply Retry keeps: what goes out again, or back to review. -->
		<blockquote
			v-if="copy.plan !== 'redraft' && message.draftResponse"
			class="mb-3 border-l-2 border-border-subtle pl-3 text-sm text-text-secondary whitespace-pre-line line-clamp-4"
			data-testid="thread-failed-reply"
		>
			{{ message.draftResponse }}
		</blockquote>
		<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
			<UiButton
				variant="secondary"
				size="sm"
				class="gap-1"
				:disabled="retrying"
				@click="emit('retry')"
			>
				<Icon
					:name="copy.plan === 'sendAgain' ? 'lucide:send' : 'lucide:refresh-cw'"
					class="w-3 h-3"
				/>
				{{ t(copy.action) }}
			</UiButton>
			<p class="text-xs text-text-secondary">{{ t(copy.hint) }}</p>
		</div>
	</div>
</template>
