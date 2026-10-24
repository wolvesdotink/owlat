<script setup lang="ts">
/**
 * Said above a Team Inbox thread the auto-close sweep resolved: when, after
 * how many quiet days, and a Reopen. Shown only while that resolve stands; any
 * later status change or customer reply clears it on the server. Presentation
 * only: the page owns the write.
 */
import { formatRelativeTime } from '~/utils/formatters';

const props = defineProps<{
	autoClosedAt: number;
	/** The rule's days when it closed; `null` when the rule is off now. */
	quietDays: number | null;
	canReopen: boolean;
	busy?: boolean;
}>();

const emit = defineEmits<{ reopen: [] }>();

const { t, locale } = useI18n();

const message = computed(() => {
	const time = formatRelativeTime(props.autoClosedAt);
	return props.quietDays === null
		? t('dashboard.inbox.detail.autoClose.noticeNoDays', { time })
		: t(
				'dashboard.inbox.detail.autoClose.notice',
				{ time, days: props.quietDays },
				props.quietDays
			);
});

const absolute = computed(() =>
	new Date(props.autoClosedAt).toLocaleString(locale.value, {
		dateStyle: 'medium',
		timeStyle: 'short',
	})
);
</script>

<template>
	<div
		class="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-subtle bg-bg-surface px-4 py-3"
		role="status"
		data-testid="thread-auto-closed-notice"
	>
		<p class="flex min-w-0 items-center gap-2 text-sm text-text-secondary">
			<Icon
				name="lucide:timer-off"
				class="h-4 w-4 shrink-0 text-text-tertiary"
				aria-hidden="true"
			/>
			<span :title="absolute">{{ message }}</span>
		</p>
		<UiButton
			v-if="canReopen"
			variant="secondary"
			size="sm"
			class="gap-1.5"
			:disabled="busy"
			data-testid="thread-auto-closed-reopen"
			@click="emit('reopen')"
		>
			<Icon name="lucide:rotate-ccw" class="h-4 w-4" />
			{{ t('dashboard.inbox.detail.autoClose.reopen') }}
		</UiButton>
	</div>
</template>
