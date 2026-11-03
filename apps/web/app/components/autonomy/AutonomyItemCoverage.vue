<script setup lang="ts">
/**
 * The `item_coverage` auto-send gate's setting: whether an automatic reply that misses an open item of the
 * thread, says a file is attached that is not, or makes a commitment nobody
 * authorised is held for review. Off by default: the gate then only records
 * what it would have held, beside the would-have-sent observations.
 *
 * It can only hold replies, never send one.
 */
import { api } from '@owlat/api';
import { ITEM_COVERAGE_ENFORCED_DEFAULT } from '~/utils/autonomyDefaults';
import SettingsResetToDefault from '~/components/settings/ResetToDefault.vue';
import { ListChecklistIcon } from '@coolicons/vue';

const props = defineProps<{ enforced: boolean }>();

const { t } = useI18n();
const { showToast } = useToast();
const { run, isLoading } = useBackendOperation(api.agent.configMutations.updateConfig, {
	label: () => t('components.autonomy.autonomyItemCoverage.operation'),
});

async function setEnforced(value: boolean) {
	if (value === props.enforced) return;
	const result = await run({ isItemCoverageEnforced: value });
	if (result.ok) showToast(t('components.autonomy.autonomyItemCoverage.saved'));
}
</script>

<template>
	<UiCard data-testid="item-coverage">
		<div class="flex items-center justify-between gap-4">
			<div class="flex items-center gap-3">
				<UiIconBox :icon="ListChecklistIcon" size="sm" variant="surface" />
				<div>
					<div class="flex items-center gap-2">
						<h3 class="text-base font-medium text-text-primary">
							{{ t('components.autonomy.autonomyItemCoverage.title') }}
						</h3>
						<SettingsResetToDefault
							:changed="enforced !== ITEM_COVERAGE_ENFORCED_DEFAULT"
							:label="t('components.autonomy.autonomyItemCoverage.title')"
							:disabled="isLoading"
							@reset="setEnforced(ITEM_COVERAGE_ENFORCED_DEFAULT)"
						/>
					</div>
					<p class="text-xs text-text-tertiary">
						{{ t('components.autonomy.autonomyItemCoverage.subtitle') }}
					</p>
				</div>
			</div>
			<UiSwitch
				:model-value="enforced"
				:disabled="isLoading"
				:label="t('components.autonomy.autonomyItemCoverage.title')"
				@update:model-value="setEnforced"
			/>
		</div>
	</UiCard>
</template>
