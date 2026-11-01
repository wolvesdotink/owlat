<script setup lang="ts">
import { computed } from 'vue';
import { AccessibilityIcon, MailIcon, MonitorIcon, ShieldIcon } from '@coolicons/vue';
import type { PreviewHealthScore } from '../../types';
import { scoreBand, scoreColor } from '../../scoreBands';
import AnalysisEmpty from './AnalysisEmpty.vue';
import { meterFillStyle } from '@owlat/ui/utils/meterFill';
import { useBuilderI18n } from '../../../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

const props = defineProps<{
	healthScore: PreviewHealthScore | null;
}>();

const overallScoreColor = computed(() => {
	if (!props.healthScore) return 'var(--ep-text-tertiary)';
	return scoreColor(props.healthScore.overall);
});

const overallScoreLabel = computed(() => {
	if (!props.healthScore) return t('builder.analysis.health.notAvailable');
	return t(`builder.analysis.health.band.${scoreBand(props.healthScore.overall)}`);
});

const subScores = computed(() => {
	if (!props.healthScore) return [];
	return [
		{
			id: 'compatibility',
			label: t('builder.analysis.health.compatibility'),
			value: props.healthScore.compatibility,
			icon: ShieldIcon,
		},
		{
			id: 'accessibility',
			label: t('builder.analysis.health.accessibility'),
			value: props.healthScore.accessibility,
			icon: AccessibilityIcon,
		},
		{
			id: 'deliverability',
			label: t('builder.analysis.health.deliverability'),
			value: props.healthScore.deliverability,
			icon: MailIcon,
		},
		{
			id: 'outlook',
			label: t('builder.analysis.health.outlook'),
			value: props.healthScore.outlookSupport,
			icon: MonitorIcon,
		},
	];
});

const scoreBarColor = scoreColor;
</script>

<template>
	<template v-if="healthScore">
		<!-- Overall Score Gauge -->
		<div class="ep-health-gauge">
			<div class="ep-health-score" :style="{ color: overallScoreColor }">
				{{ Math.round(healthScore.overall) }}
			</div>
			<div class="ep-health-label" :style="{ color: overallScoreColor }">
				{{ overallScoreLabel }}
			</div>
			<div class="ep-health-bar-track">
				<div
					class="ep-health-bar-fill"
					:style="[meterFillStyle(healthScore.overall), { background: overallScoreColor }]"
				></div>
			</div>
		</div>

		<!-- Sub-scores -->
		<div class="ep-health-subscores">
			<div v-for="score in subScores" :key="score.id" class="ep-health-subscore">
				<div class="ep-health-subscore-header">
					<component :is="score.icon" class="ep-health-subscore-icon" />
					<span class="ep-health-subscore-label">{{ score.label }}</span>
					<span class="ep-health-subscore-value" :style="{ color: scoreBarColor(score.value) }">
						{{ Math.round(score.value) }}
					</span>
				</div>
				<div class="ep-health-subscore-track">
					<div
						class="ep-health-subscore-fill"
						:style="[meterFillStyle(score.value), { background: scoreBarColor(score.value) }]"
					></div>
				</div>
			</div>
		</div>

		<!-- Recommendations -->
		<div v-if="healthScore.recommendations.length > 0" class="ep-health-recommendations">
			<div class="ep-health-recommendations-title">
				{{ t('builder.analysis.health.recommendations') }}
			</div>
			<div
				v-for="(rec, idx) in healthScore.recommendations"
				:key="idx"
				class="ep-health-rec"
				:class="`ep-health-rec-${rec.impact}`"
			>
				<span class="ep-health-rec-impact">{{
					t(`builder.analysis.health.impact.${rec.impact}`)
				}}</span>
				<span class="ep-health-rec-message">{{ rec.message }}</span>
			</div>
		</div>
	</template>
	<AnalysisEmpty v-else>{{ t('builder.analysis.health.empty') }}</AnalysisEmpty>
</template>

<style scoped>
.ep-health-gauge {
	text-align: center;
	margin-bottom: 16px;
}

.ep-health-score {
	font-size: 36px;
	font-weight: 700;
	line-height: 1;
}

.ep-health-label {
	font-size: 12px;
	font-weight: 500;
	margin-top: 4px;
}

.ep-health-bar-track {
	height: 4px;
	background: var(--ep-bg-overlay);
	border-radius: 2px;
	margin-top: 8px;
	overflow: hidden;
}

/* Full-width fill slid in from the left (the `.ui-meter-fill` recipe): a score
 * change moves a composited layer instead of re-laying-out the panel. */
.ep-health-bar-fill,
.ep-health-subscore-fill {
	height: 100%;
	width: 100%;
	border-radius: 2px;
	transform: translateX(calc(var(--ui-meter-value, 0) * 1% - 100%));
	transition: transform var(--motion-moderate, 160ms)
		var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
}

.ep-health-subscores {
	display: flex;
	flex-direction: column;
	gap: 10px;
}

.ep-health-subscore-header {
	display: flex;
	align-items: center;
	gap: 6px;
	margin-bottom: 4px;
}

.ep-health-subscore-icon {
	width: 12px;
	height: 12px;
	color: var(--ep-text-tertiary);
}

.ep-health-subscore-label {
	font-size: 12px;
	color: var(--ep-text-secondary);
	flex: 1;
}

.ep-health-subscore-value {
	font-size: 12px;
	font-weight: 600;
}

.ep-health-subscore-track {
	height: 3px;
	background: var(--ep-bg-overlay);
	border-radius: 2px;
	overflow: hidden;
}

.ep-health-recommendations {
	margin-top: 16px;
}

.ep-health-recommendations-title {
	font-size: 11px;
	font-weight: 600;
	color: var(--ep-text-tertiary);
	text-transform: uppercase;
	letter-spacing: 0.05em;
	margin-bottom: 8px;
}

.ep-health-rec {
	display: flex;
	align-items: flex-start;
	gap: 8px;
	padding: 6px 0;
	font-size: 12px;
	line-height: 1.4;
}

.ep-health-rec-impact {
	flex-shrink: 0;
	padding: 1px 6px;
	border-radius: 4px;
	font-size: 10px;
	font-weight: 600;
	text-transform: uppercase;
}

.ep-health-rec-high .ep-health-rec-impact {
	background: var(--ep-error-subtle);
	color: var(--ep-error);
}

.ep-health-rec-medium .ep-health-rec-impact {
	background: var(--ep-warning-subtle);
	color: var(--ep-warning);
}

.ep-health-rec-low .ep-health-rec-impact {
	background: var(--ep-bg-overlay);
	color: var(--ep-text-tertiary);
}

.ep-health-rec-message {
	color: var(--ep-text-secondary);
}
</style>
