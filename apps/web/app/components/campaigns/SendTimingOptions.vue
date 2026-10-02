<script setup lang="ts">
/**
 * How a scheduled campaign picks each recipient's delivery time: one instant
 * for everyone, the chosen time in each recipient's time zone, or "Optimized
 * per contact" with its window, comparison group and predicted distribution.
 * Shared by the wizard's review step and the campaign edit page.
 */
import type { Id } from '@owlat/api/dataModel';
import {
	SEND_TIME_HOLDOUT_OPTIONS,
	SEND_TIME_WINDOW_OPTIONS,
	type SendTiming,
	type SendTimingMode,
} from '~/lib/sendTiming';

const props = defineProps<{
	modelValue: SendTiming;
	/** The chosen start time (`HH:MM`), for the copy; empty while unset. */
	time: string;
	campaignId: Id<'campaigns'>;
	/** The chosen start, or null while it is unset or past. Feeds the preview. */
	startAt: number | null;
	/** A/B tests cannot be optimized: spreading the cohort would skew the verdict. */
	isAbTest?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: SendTiming] }>();

const { t } = useI18n();
const prefix = 'components.campaigns.sendTimingOptions';

// An unset time reads as an empty clock rather than a phrase, so the hints
// need no grammar for the missing case.
const timeLabel = computed(() => props.time || '--:--');

const modes = computed(() => [
	{
		value: 'fixed' as const,
		icon: 'lucide:clock',
		title: t(`${prefix}.fixed.title`),
		hint: t(`${prefix}.fixed.hint`, { time: timeLabel.value }),
		disabled: false,
	},
	{
		value: 'local' as const,
		icon: 'lucide:globe',
		title: t(`${prefix}.local.title`),
		hint: t(`${prefix}.local.hint`, { time: timeLabel.value }),
		disabled: false,
	},
	{
		value: 'optimized' as const,
		icon: 'lucide:sparkles',
		title: t(`${prefix}.optimized.title`),
		hint: props.isAbTest ? t(`${prefix}.optimized.abTest`) : t(`${prefix}.optimized.hint`),
		disabled: props.isAbTest === true,
	},
]);

const windowOptions = computed(() =>
	SEND_TIME_WINDOW_OPTIONS.map((hours) => ({
		value: hours,
		label: t(`${prefix}.windowOption`, { hours }),
	}))
);

const holdoutOptions = computed(() =>
	SEND_TIME_HOLDOUT_OPTIONS.map((percent) => ({
		value: percent,
		label: percent === 0 ? t(`${prefix}.holdoutNone`) : t(`${prefix}.holdoutOption`, { percent }),
	}))
);

function update(patch: Partial<SendTiming>) {
	emit('update:modelValue', { ...props.modelValue, ...patch });
}

function selectMode(mode: SendTimingMode) {
	update({ mode });
}
</script>

<template>
	<fieldset class="space-y-2" data-testid="send-timing-options">
		<legend class="label mb-2">{{ t(`${prefix}.legend`) }}</legend>
		<label
			v-for="mode in modes"
			:key="mode.value"
			:class="[
				'flex items-start gap-3 p-3 rounded-lg border transition-colors',
				mode.disabled
					? 'cursor-not-allowed border-border-subtle opacity-60'
					: modelValue.mode === mode.value
						? 'cursor-pointer border-text-primary bg-bg-elevated'
						: 'cursor-pointer border-border-subtle hover:border-border-default',
			]"
			:data-mode="mode.value"
		>
			<input
				type="radio"
				name="sendTiming"
				:value="mode.value"
				:checked="modelValue.mode === mode.value"
				:disabled="mode.disabled"
				class="mt-0.5 w-4 h-4 text-text-primary focus:ring-brand border-border-subtle bg-bg-surface"
				@change="selectMode(mode.value)"
			/>
			<div class="flex-1 min-w-0">
				<div class="flex items-center gap-2">
					<Icon :name="mode.icon" class="w-4 h-4 text-text-tertiary" />
					<span class="font-medium text-text-primary text-sm">{{ mode.title }}</span>
				</div>
				<p class="text-xs text-text-secondary mt-1">{{ mode.hint }}</p>
			</div>
		</label>

		<div
			v-if="modelValue.mode === 'optimized'"
			class="mt-3 space-y-4 rounded-lg bg-bg-elevated shadow-surface-1 p-4"
			data-testid="send-timing-optimized"
		>
			<div class="grid gap-4 sm:grid-cols-2">
				<UiSelect
					:model-value="modelValue.windowHours"
					:options="windowOptions"
					:label="t(`${prefix}.windowLabel`)"
					size="sm"
					@update:model-value="(value) => value !== null && update({ windowHours: value })"
				/>
				<UiSelect
					:model-value="modelValue.holdoutPercent"
					:options="holdoutOptions"
					:label="t(`${prefix}.holdoutLabel`)"
					size="sm"
					@update:model-value="(value) => value !== null && update({ holdoutPercent: value })"
				/>
			</div>
			<p class="text-xs text-text-tertiary">{{ t(`${prefix}.holdoutHint`) }}</p>
			<CampaignsSendTimeDistribution
				:campaign-id="campaignId"
				:start-at="startAt"
				:window-hours="modelValue.windowHours"
				:holdout-percent="modelValue.holdoutPercent"
			/>
		</div>
	</fieldset>
</template>
