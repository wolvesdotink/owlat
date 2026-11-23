<script setup lang="ts">
/**
 * Why a failed run failed, under its row: one sentence for the coded reason,
 * the page that fixes it, and the step's stored text one click away. A run
 * whose email step waits for the sending setup (`failure.until` set) gets the
 * same note worded as a wait, with the date it gives up.
 *
 * Every fix needs an admin: the settings pages are admin-only
 * (`middleware/admin.ts`) and saving the automation needs `automations:manage`.
 * A member gets "ask an admin" instead of a link they cannot use, as on a
 * refused campaign send.
 */
import { runFailureNote, type AutomationRunFailure } from '~/lib/automationRunFailure';
import { formatDateTime } from '~/utils/formatters';

const props = defineProps<{ failure: AutomationRunFailure; automationId: string }>();

const { t } = useI18n();
const { isAdmin } = usePermissions();

const note = computed(() => runFailureNote(props.failure, props.automationId));
const message = computed(() =>
	t(note.value.messageKey, { date: formatDateTime(props.failure.until) })
);
</script>

<template>
	<div
		class="space-y-1 text-sm"
		:data-testid="failure.until === undefined ? 'run-failure' : 'run-waiting'"
	>
		<p class="text-text-secondary">
			{{ message }}
			<NuxtLink
				v-if="note.fix && isAdmin"
				:to="note.fix.to"
				class="link font-medium whitespace-nowrap"
				data-testid="run-failure-fix"
			>
				{{ t(note.fix.labelKey) }}
			</NuxtLink>
			<span v-else-if="note.fix" class="text-text-tertiary">
				{{ t(note.fix.askKey ?? 'shared.campaignRefusal.askAdmin') }}
			</span>
		</p>
		<details v-if="note.detail" class="group" data-testid="run-failure-detail">
			<summary
				class="w-fit cursor-pointer select-none rounded text-xs text-text-tertiary hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
			>
				{{ t('dashboard.automations.detail.index.runs.failure.details') }}
			</summary>
			<p class="mt-1 break-words font-mono text-xs text-text-secondary">{{ note.detail }}</p>
		</details>
	</div>
</template>
