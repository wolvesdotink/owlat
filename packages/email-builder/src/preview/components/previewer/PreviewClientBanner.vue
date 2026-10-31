<script setup lang="ts">
import { computed } from 'vue';
import { AlertTriangle } from '@lucide/vue';
import type { EmailClient } from '../../types';
import type { SimulationResult } from '../../clientSimulation';
import { useBuilderI18n } from '../../../i18n/useBuilderI18n';

const { t, label } = useBuilderI18n();

const props = defineProps<{
	selectedClient: EmailClient;
	simulationResult: SimulationResult;
}>();

const hasSimulationAdjustments = computed(
	() =>
		props.simulationResult.removedCssDeclarations > 0 ||
		props.simulationResult.removedElements > 0 ||
		props.simulationResult.strippedAttributes > 0 ||
		props.simulationResult.blockedImages > 0
);
const simulationSummary = computed(() => {
	const result = props.simulationResult;
	return t('builder.preview.client.adjustments', {
		declarations: t('builder.preview.client.declarations', {
			count: result.removedCssDeclarations,
		}),
		elements: t('builder.preview.client.elements', { count: result.removedElements }),
		attributes: t('builder.preview.client.attributes', { count: result.strippedAttributes }),
		images: t('builder.preview.client.images', { count: result.blockedImages }),
	});
});
</script>

<template>
	<div class="ep-client-banner">
		<span class="ep-client-banner-text">
			{{ t('builder.preview.client.previewingAs') }}
			<strong>{{ selectedClient.name }}</strong>
			<template v-if="selectedClient.renderingEngine">
				{{ t('builder.preview.client.engine', { engine: selectedClient.renderingEngine }) }}
			</template>
		</span>
		<div class="ep-simulation-note">
			<AlertTriangle class="ep-simulation-icon" />
			<span>
				{{ t('builder.preview.client.simulated') }}
				<template v-if="hasSimulationAdjustments">
					{{ simulationSummary }}
				</template>
			</span>
		</div>
		<span v-if="selectedClient.quirks?.length" class="ep-client-quirks">
			{{
				t('builder.preview.client.quirks', {
					quirks: selectedClient.quirks.map((quirk) => label(quirk)).join(', '),
				})
			}}
		</span>
	</div>
</template>

<style scoped>
/* Client Banner */
.ep-client-banner {
	display: flex;
	flex-direction: column;
	gap: 4px;
	padding: 10px 16px;
	background: var(--ep-bg-surface);
	border-top: 1px solid var(--ep-border-subtle);
}

.ep-client-banner-text {
	font-size: 12px;
	color: var(--ep-text-secondary);
}

.ep-client-banner-text strong {
	color: var(--ep-text-primary);
}

.ep-simulation-note {
	display: flex;
	align-items: flex-start;
	gap: 6px;
	padding: 8px 10px;
	border-radius: 8px;
	background: var(--ep-warning-subtle);
	color: var(--ep-warning);
	font-size: 11px;
	line-height: 1.4;
}

.ep-simulation-icon {
	width: 13px;
	height: 13px;
	flex-shrink: 0;
	margin-top: 1px;
}

.ep-client-quirks {
	font-size: 11px;
	color: var(--ep-text-tertiary);
}
</style>
