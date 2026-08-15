<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { formatDateTime } from '~/utils/formatters';

// Renders a form's recent submission records. Its own query so it only runs
// when the parent form is expanded (the parent can't call useConvexQuery in a
// v-for). Auto-imports as <FormsSubmissionsPanel> (path-prefixed).
const props = defineProps<{ formEndpointId: Id<'formEndpoints'> }>();

const { t } = useI18n();

const { data: submissions, isLoading } = useConvexQuery(
	api.forms.endpoints.getSubmissions,
	() => ({ formEndpointId: props.formEndpointId, limit: 50 }),
);

// Keyed by the schema's submission-status literals; anything outside that union
// falls back to the raw value rather than painting a missing key path.
const STATUS_LABEL_KEYS: Record<string, string> = {
	success: 'components.forms.submissionsPanel.statuses.success',
	pending_confirmation: 'components.forms.submissionsPanel.statuses.pending_confirmation',
	duplicate: 'components.forms.submissionsPanel.statuses.duplicate',
	spam: 'components.forms.submissionsPanel.statuses.spam',
	invalid: 'components.forms.submissionsPanel.statuses.invalid',
};

function statusLabel(status: string): string {
	const key = STATUS_LABEL_KEYS[status];
	return key ? t(key) : status;
}

function statusClass(status: string): string {
	switch (status) {
		case 'success':
			return 'text-success bg-success-subtle';
		case 'pending_confirmation':
			return 'text-warning bg-warning/10';
		case 'spam':
		case 'invalid':
			return 'text-error bg-error-subtle';
		default:
			return 'text-text-tertiary bg-bg-surface';
	}
}
</script>

<template>
	<div>
		<h4 class="text-sm font-medium text-text-primary mb-3">
			{{ t('components.forms.submissionsPanel.title') }}
		</h4>
		<div v-if="isLoading" class="text-text-tertiary text-sm py-4">{{ t('common.loading') }}</div>
		<div v-else-if="!submissions || submissions.length === 0" class="text-text-tertiary text-sm py-4">
			{{ t('components.forms.submissionsPanel.empty') }}
		</div>
		<div v-else class="space-y-2 max-h-80 overflow-y-auto">
			<div
				v-for="s in submissions"
				:key="s._id"
				class="bg-bg-elevated rounded-lg p-3 border border-border-subtle text-sm"
			>
				<div class="flex items-center justify-between mb-1.5">
					<span :class="['px-2 py-0.5 rounded-full text-xs font-medium', statusClass(s.status)]">
						{{ statusLabel(s.status) }}
					</span>
					<span class="text-text-tertiary text-xs">{{ formatDateTime(s._creationTime) }}</span>
				</div>
				<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
					<template v-for="(value, key) in s.data" :key="key">
						<dt class="text-text-tertiary truncate">{{ key }}</dt>
						<dd class="text-text-primary truncate">{{ value }}</dd>
					</template>
				</dl>
				<p v-if="s.confirmationEmailSentAt" class="text-text-tertiary text-xs mt-1.5">
					{{
						t('components.forms.submissionsPanel.confirmationSent', {
							time: formatRelativeTime(s.confirmationEmailSentAt),
						})
					}}
				</p>
			</div>
		</div>
	</div>
</template>
