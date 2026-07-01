<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { formatDateTime } from '~/utils/formatters';

// Renders a form's recent submission records. Its own query so it only runs
// when the parent form is expanded (the parent can't call useConvexQuery in a
// v-for). Auto-imports as <FormsSubmissionsPanel> (path-prefixed).
const props = defineProps<{ formEndpointId: Id<'formEndpoints'> }>();

const { data: submissions, isLoading } = useConvexQuery(
	api.forms.endpoints.getSubmissions,
	() => ({ formEndpointId: props.formEndpointId, limit: 50 }),
);

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
		<h4 class="text-sm font-medium text-text-primary mb-3">Recent submissions</h4>
		<div v-if="isLoading" class="text-text-tertiary text-sm py-4">Loading…</div>
		<div v-else-if="!submissions || submissions.length === 0" class="text-text-tertiary text-sm py-4">
			No submissions yet.
		</div>
		<div v-else class="space-y-2 max-h-80 overflow-y-auto">
			<div
				v-for="s in submissions"
				:key="s._id"
				class="bg-bg-elevated rounded-lg p-3 border border-border-subtle text-sm"
			>
				<div class="flex items-center justify-between mb-1.5">
					<span :class="['px-2 py-0.5 rounded-full text-xs font-medium', statusClass(s.status)]">
						{{ s.status }}
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
					Confirmation email sent {{ formatRelativeTime(s.confirmationEmailSentAt) }}
				</p>
			</div>
		</div>
	</div>
</template>
