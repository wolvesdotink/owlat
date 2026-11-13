<script setup lang="ts">
/**
 * The automation's funnel: the trigger row (everyone who entered, 100%) and
 * one row per step, its bar filled by the share of entered contacts that
 * completed it, with the contacts still pending, executing or failed there.
 * The empty, loading and failed states stay with the page's funnel card.
 */
import type { api } from '@owlat/api';
import type { Doc } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';
import { stepEditorModuleFor, type StepKind } from '~/composables/automations/steps';
import type { AutomationTriggerType } from '~/composables/useAutomationBadges';
import { formatNumber } from '~/utils/formatters';
import { useLocalized } from '~/composables/useLocalized';
import { useFormat } from '~/composables/useFormat';
import type { LocalizedText } from '~/utils/localizedText';
import { meterFillStyle } from '@owlat/ui/utils/meterFill';
import { CircleCloseIcon, ClockIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

const props = defineProps<{
	steps: FunctionReturnType<typeof api.automations.analytics.getStepAnalytics>;
	triggerType: AutomationTriggerType;
	totalEntered: number;
	/** The email steps' templates, so an email step is labelled by its template's name. */
	emailTemplates: Doc<'emailTemplates'>[];
}>();

const { t } = useI18n();
const { formatPercentage } = useFormat();

/**
 * Registry-owned copy (step modules) carries message KEYS, so every rendered
 * registry value goes through here.
 */
const registryText = useLocalized();

const { getTriggerDisplay } = useAutomationBadges();
const trigger = computed(() => getTriggerDisplay(props.triggerType));

// Step label — resolved through the step editor module's getDescription.
// `parseConfig` throws on malformed input; we fall back to the bare label.
const getStepLabel = (stepType: StepKind, config: string | Record<string, unknown>) => {
	const module = stepEditorModuleFor(stepType);
	try {
		const raw = typeof config === 'string' ? JSON.parse(config) : config;
		return registryText(
			(
				module.getDescription as (
					c: unknown,
					ctx: { emailTemplates: Doc<'emailTemplates'>[] }
				) => LocalizedText
			)(module.parseConfig(raw), { emailTemplates: props.emailTemplates })
		);
	} catch {
		return registryText(module.label);
	}
};

// Step icon — resolved through the step editor module registry.
const stepInfo = (stepType: string) => {
	const module = stepEditorModuleFor(stepType as StepKind);
	return { icon: module.icon, label: module.label };
};

// Page-local accent palette per step kind for the funnel rows. The edit
// page uses a different palette; both pages own their own STEP_ACCENT
// rather than smearing a shared color across modules that don't need it.
type FunnelAccent = {
	readonly iconBg: string;
	readonly iconText: string;
	readonly barBg: string;
};

const STEP_ACCENT: Readonly<Record<StepKind, FunnelAccent>> = {
	email: { iconBg: 'bg-warning/10', iconText: 'text-warning', barBg: 'bg-warning/20' },
	delay: { iconBg: 'bg-brand/10', iconText: 'text-brand', barBg: 'bg-brand/20' },
	condition: {
		iconBg: 'bg-text-tertiary/10',
		iconText: 'text-text-tertiary',
		barBg: 'bg-text-tertiary/20',
	},
};

const stepAccent = (stepType: string): FunnelAccent => STEP_ACCENT[stepType as StepKind];

// Calculate funnel percentages
const getFunnelPercentage = (
	stepStats: { total: number; completed: number },
	totalEntered: number
) => {
	if (totalEntered === 0) return 0;
	return Math.round((stepStats.completed / totalEntered) * 100);
};
</script>

<template>
	<div class="space-y-4">
		<!-- Trigger row -->
		<div class="flex items-center gap-4">
			<div class="hidden sm:block w-24 shrink-0 text-right">
				<span class="text-xs text-text-tertiary uppercase tracking-wider">
					{{ t('dashboard.automations.detail.index.funnel.trigger') }}
				</span>
			</div>
			<div class="flex-1 min-w-0">
				<div class="flex items-center gap-3">
					<div :class="['p-2 rounded-lg', trigger.bgColor]">
						<component :is="trigger.icon" :class="['w-4 h-4', trigger.color]" size="1em" />
					</div>
					<div class="flex-1 min-w-0">
						<div class="h-8 bg-brand/20 rounded-lg flex items-center px-4" style="width: 100%">
							<span class="text-sm font-medium text-text-primary">
								{{
									t('dashboard.automations.detail.index.funnel.entered', {
										count: formatNumber(totalEntered),
									})
								}}
							</span>
						</div>
					</div>
					<span class="w-12 sm:w-16 shrink-0 text-right text-sm text-text-secondary tabular-nums">{{
						formatPercentage(100, 0, false)
					}}</span>
				</div>
			</div>
		</div>

		<!-- Connector -->
		<div class="flex items-center gap-4">
			<div class="hidden sm:block w-24 shrink-0" />
			<div class="flex-1 flex justify-start pl-5">
				<div class="w-0.5 h-6 bg-border-subtle" />
			</div>
			<div class="w-12 sm:w-16" />
		</div>

		<!-- Step rows -->
		<template v-for="(step, index) in steps" :key="step.stepId">
			<div class="flex items-center gap-4">
				<div class="hidden sm:block w-24 shrink-0 text-right">
					<span class="text-xs text-text-tertiary uppercase tracking-wider">
						{{ t('dashboard.automations.detail.index.funnel.step', { number: index + 1 }) }}
					</span>
				</div>
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-3">
						<div :class="['p-2 rounded-lg', stepAccent(step.stepType).iconBg]">
							<component
								:is="stepInfo(step.stepType).icon"
								:class="['w-4 h-4', stepAccent(step.stepType).iconText]"
								size="1em"
							/>
						</div>
						<div class="flex-1 min-w-0">
							<!-- The fill is proportional; the label spans the whole track, so
							     a short bar no longer cuts "472 completed" down to "472 co…". -->
							<div class="relative min-h-8 rounded-lg overflow-hidden flex items-center">
								<div
									class="ui-meter-fill absolute inset-y-0 left-0 rounded-lg transition-transform"
									:class="stepAccent(step.stepType).barBg"
									:style="
										meterFillStyle(
											step.stats.completed > 0
												? Math.max(getFunnelPercentage(step.stats, totalEntered), 4)
												: 0
										)
									"
								/>
								<!-- Wraps on a phone, one line from sm up. -->
								<span
									class="relative px-4 py-1.5 sm:py-0 text-sm font-medium text-text-primary sm:truncate"
								>
									{{
										t('dashboard.automations.detail.index.funnel.stepSummary', {
											label: getStepLabel(step.stepType, step.config),
											completed: formatNumber(step.stats.completed),
										})
									}}
								</span>
							</div>
						</div>
						<span class="w-12 sm:w-16 shrink-0 text-right text-sm text-text-secondary tabular-nums">
							{{ formatPercentage(getFunnelPercentage(step.stats, totalEntered), 0, false) }}
						</span>
					</div>
					<!-- Step details -->
					<div
						class="ml-11 mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-tertiary"
					>
						<span v-if="step.stats.pending > 0" class="flex items-center gap-1">
							<ClockIcon class="w-3 h-3" />
							{{
								t('dashboard.automations.detail.index.funnel.pending', {
									count: step.stats.pending,
								})
							}}
						</span>
						<span v-if="step.stats.executing > 0" class="flex items-center gap-1">
							<SpinnerIcon class="w-3 h-3" />
							{{
								t('dashboard.automations.detail.index.funnel.executing', {
									count: step.stats.executing,
								})
							}}
						</span>
						<span v-if="step.stats.failed > 0" class="flex items-center gap-1 text-error">
							<CircleCloseIcon class="w-3 h-3" />
							{{
								t('dashboard.automations.detail.index.funnel.failed', {
									count: step.stats.failed,
								})
							}}
						</span>
					</div>
				</div>
			</div>

			<!-- Connector between steps -->
			<div v-if="index < steps.length - 1" class="flex items-center gap-4">
				<div class="hidden sm:block w-24 shrink-0" />
				<div class="flex-1 flex justify-start pl-5">
					<div class="w-0.5 h-6 bg-border-subtle" />
				</div>
				<div class="w-12 sm:w-16" />
			</div>
		</template>
	</div>
</template>
