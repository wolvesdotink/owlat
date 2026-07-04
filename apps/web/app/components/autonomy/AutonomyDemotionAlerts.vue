<script setup lang="ts">
/**
 * Auto-demotion INCIDENT alerts.
 *
 * Surfaces senders/categories that were auto-demoted to draft-only after a
 * confirmed bad auto-send outcome (angry reply / bounce / complaint). Emits
 * `acknowledge` to dismiss an incident; the sender stays draft-only until the
 * operator deliberately re-enables it. Presentational + prop-driven.
 */
interface DemotionIncident {
	_id: string;
	category: string;
	sender: string | null;
	autoDemotedAt: number;
	autoDemotedReason: string | null;
	autoDemotedSignal: string | null;
}

interface Props {
	incidents?: DemotionIncident[] | null;
	pendingId?: string | null;
}
const props = withDefaults(defineProps<Props>(), { incidents: () => [], pendingId: null });

const emit = defineEmits<{ acknowledge: [payload: { ruleId: string }] }>();

const hasIncidents = computed(() => (props.incidents ?? []).length > 0);
</script>

<template>
	<UiCard v-if="hasIncidents" data-testid="demotion-alerts" class="border-error/40">
		<div class="flex items-center gap-3 mb-4">
			<UiIconBox icon="lucide:shield-alert" size="sm" variant="error" />
			<div>
				<h3 class="text-base font-medium text-text-primary">
					Auto-send paused after a bad outcome
				</h3>
				<p class="text-xs text-text-tertiary">
					These senders were reverted to draft-only after a confirmed bad auto-send. Review before
					re-enabling.
				</p>
			</div>
		</div>

		<ul class="space-y-3">
			<li
				v-for="incident in incidents ?? []"
				:key="incident._id"
				data-testid="demotion-incident"
				class="flex items-center justify-between gap-4 rounded-lg border border-border-subtle p-3"
			>
				<div class="min-w-0">
					<p class="text-sm text-text-primary">
						<strong class="break-all">{{ incident.sender ?? incident.category }}</strong>
						<span class="text-text-tertiary"> ({{ incident.category }})</span>
					</p>
					<p class="text-xs text-text-tertiary mt-0.5">
						{{ incident.autoDemotedReason ?? 'Auto-demoted to draft-only after a bad outcome.' }}
					</p>
				</div>
				<button
					class="btn btn-secondary btn-sm shrink-0"
					:disabled="pendingId === incident._id"
					@click="emit('acknowledge', { ruleId: incident._id })"
				>
					Dismiss
				</button>
			</li>
		</ul>
	</UiCard>
</template>
