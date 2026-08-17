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
const { t } = useI18n();

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
					{{ t('components.autonomy.autonomyDemotionAlerts.title') }}
				</h3>
				<p class="text-xs text-text-tertiary">
					{{ t('components.autonomy.autonomyDemotionAlerts.body') }}
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
						<I18nT
							keypath="components.autonomy.autonomyDemotionAlerts.incident"
							tag="span"
							scope="global"
						>
							<template #sender>
								<strong class="break-all">{{ incident.sender ?? incident.category }}</strong>
							</template>
							<template #category>
								<span class="text-text-tertiary">{{ incident.category }}</span>
							</template>
						</I18nT>
					</p>
					<p class="text-xs text-text-tertiary mt-0.5">
						{{
							incident.autoDemotedReason ??
							t('components.autonomy.autonomyDemotionAlerts.defaultReason')
						}}
					</p>
				</div>
				<UiButton
					variant="secondary"
					size="sm"
					class="shrink-0"
					:disabled="pendingId === incident._id"
					@click="emit('acknowledge', { ruleId: incident._id })"
				>
					{{ t('common.dismiss') }}
				</UiButton>
			</li>
		</ul>
	</UiCard>
</template>
