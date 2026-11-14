<script setup lang="ts">
/**
 * The transactional send caps on the API settings page, where an admin who
 * just got a 429 looks. Shows the caps in force and what each protects
 * against; "Change limits" opens the form in place. Emits `save`; the page
 * persists it (`transactional/sendCapSettings.ts` `update`, which applies the
 * same bounds). Presentational.
 */
import { GaugeIcon } from '@coolicons/vue';

export interface SendCaps {
	perRecipient: { isEnabled: boolean; count: number; windowMs: number };
	perApiKeyDaily: { isEnabled: boolean; count: number };
}

export interface SendCapBounds {
	perRecipientCount: { min: number; max: number };
	perApiKeyDailyCount: { min: number; max: number };
}

const props = defineProps<{
	caps: SendCaps;
	defaults: SendCaps;
	bounds: SendCapBounds;
	canManage: boolean;
	busy?: boolean;
}>();

const emit = defineEmits<{ save: [caps: SendCaps] }>();

const { t, locale } = useI18n();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WINDOW_PRESETS = [10 * MINUTE, HOUR, 6 * HOUR, 24 * HOUR];

const copy = (caps: SendCaps): SendCaps => ({
	perRecipient: { ...caps.perRecipient },
	perApiKeyDaily: { ...caps.perApiKeyDaily },
});

const isEditing = ref(false);
const form = reactive(copy(props.caps));
watch(
	() => props.caps,
	(next) => {
		if (!isEditing.value) Object.assign(form, copy(next));
	}
);

const formatCount = (count: number) => new Intl.NumberFormat(locale.value).format(count);

function windowLabel(windowMs: number): string {
	if (windowMs % (24 * HOUR) === 0) {
		const days = windowMs / (24 * HOUR);
		return t('components.apiKeys.sendLimits.window.days', { count: days }, days);
	}
	if (windowMs % HOUR === 0) {
		const hours = windowMs / HOUR;
		return t('components.apiKeys.sendLimits.window.hours', { count: hours }, hours);
	}
	const minutes = windowMs / MINUTE;
	return t('components.apiKeys.sendLimits.window.minutes', { count: minutes }, minutes);
}

const windowOptions = computed(() => {
	const values = WINDOW_PRESETS.includes(form.perRecipient.windowMs)
		? WINDOW_PRESETS
		: [...WINDOW_PRESETS, form.perRecipient.windowMs].sort((a, b) => a - b);
	return values.map((value) => ({ value, label: windowLabel(value) }));
});

const recipientSummary = computed(() =>
	props.caps.perRecipient.isEnabled
		? t('components.apiKeys.sendLimits.perRecipient.summary', {
				count: formatCount(props.caps.perRecipient.count),
				window: windowLabel(props.caps.perRecipient.windowMs),
			})
		: t('components.apiKeys.sendLimits.off')
);
const dailySummary = computed(() =>
	props.caps.perApiKeyDaily.isEnabled
		? t('components.apiKeys.sendLimits.perApiKeyDaily.summary', {
				count: formatCount(props.caps.perApiKeyDaily.count),
			})
		: t('components.apiKeys.sendLimits.off')
);

const isWhole = (value: number, bounds: { min: number; max: number }) =>
	Number.isInteger(value) && value >= bounds.min && value <= bounds.max;

const problem = computed(() => {
	if (!isWhole(form.perRecipient.count, props.bounds.perRecipientCount)) {
		return t('components.apiKeys.sendLimits.problem', {
			min: formatCount(props.bounds.perRecipientCount.min),
			max: formatCount(props.bounds.perRecipientCount.max),
		});
	}
	if (!isWhole(form.perApiKeyDaily.count, props.bounds.perApiKeyDailyCount)) {
		return t('components.apiKeys.sendLimits.problem', {
			min: formatCount(props.bounds.perApiKeyDailyCount.min),
			max: formatCount(props.bounds.perApiKeyDailyCount.max),
		});
	}
	return null;
});

function startEditing() {
	Object.assign(form, copy(props.caps));
	isEditing.value = true;
}

function restoreDefaults() {
	Object.assign(form, copy(props.defaults));
}

function save() {
	if (problem.value) return;
	emit('save', copy(form));
	isEditing.value = false;
}
</script>

<template>
	<div class="card p-0 mb-6 overflow-hidden" data-testid="transactional-send-limits">
		<div
			class="px-6 py-4 border-b border-border-subtle bg-bg-surface/50 flex items-center justify-between gap-4"
		>
			<div class="flex items-center gap-3">
				<GaugeIcon class="w-5 h-5 text-text-tertiary" aria-hidden="true" />
				<h2 class="text-sm font-semibold text-text-primary">
					{{ t('components.apiKeys.sendLimits.title') }}
				</h2>
			</div>
			<UiButton
				v-if="canManage && !isEditing"
				variant="secondary"
				size="sm"
				data-testid="send-limits-edit"
				@click="startEditing"
			>
				{{ t('components.apiKeys.sendLimits.change') }}
			</UiButton>
		</div>

		<div class="p-6">
			<p class="text-sm text-text-secondary mb-5">
				{{ t('components.apiKeys.sendLimits.intro') }}
			</p>

			<dl v-if="!isEditing" class="grid gap-5 sm:grid-cols-2">
				<div>
					<dt class="text-sm font-medium text-text-primary">
						{{ t('components.apiKeys.sendLimits.perRecipient.title') }}
					</dt>
					<dd class="text-sm text-text-primary mt-0.5" data-testid="send-limits-recipient">
						{{ recipientSummary }}
					</dd>
					<dd class="text-sm text-text-tertiary mt-1">
						{{
							t('components.apiKeys.sendLimits.perRecipient.description', {
								default: t('components.apiKeys.sendLimits.perRecipient.summary', {
									count: formatCount(defaults.perRecipient.count),
									window: windowLabel(defaults.perRecipient.windowMs),
								}),
							})
						}}
					</dd>
				</div>
				<div>
					<dt class="text-sm font-medium text-text-primary">
						{{ t('components.apiKeys.sendLimits.perApiKeyDaily.title') }}
					</dt>
					<dd class="text-sm text-text-primary mt-0.5" data-testid="send-limits-daily">
						{{ dailySummary }}
					</dd>
					<dd class="text-sm text-text-tertiary mt-1">
						{{
							t('components.apiKeys.sendLimits.perApiKeyDaily.description', {
								default: formatCount(defaults.perApiKeyDaily.count),
							})
						}}
					</dd>
				</div>
			</dl>

			<form v-else class="space-y-5" data-testid="send-limits-form" @submit.prevent="save">
				<fieldset class="space-y-2">
					<div class="flex items-center justify-between gap-4">
						<legend class="text-sm font-medium text-text-primary">
							{{ t('components.apiKeys.sendLimits.perRecipient.title') }}
						</legend>
						<UiSwitch
							v-model="form.perRecipient.isEnabled"
							:label="t('components.apiKeys.sendLimits.perRecipient.toggle')"
							data-testid="send-limits-recipient-switch"
						/>
					</div>
					<div v-if="form.perRecipient.isEnabled" class="flex flex-wrap items-center gap-2 text-sm">
						<input
							v-model.number="form.perRecipient.count"
							type="number"
							step="1"
							:min="bounds.perRecipientCount.min"
							:max="bounds.perRecipientCount.max"
							class="input input-sm w-24"
							:aria-label="t('components.apiKeys.sendLimits.perRecipient.countLabel')"
							data-testid="send-limits-recipient-count"
						/>
						<span class="text-text-secondary">{{ t('components.apiKeys.sendLimits.per') }}</span>
						<select
							v-model.number="form.perRecipient.windowMs"
							class="input input-sm w-36"
							:aria-label="t('components.apiKeys.sendLimits.perRecipient.windowLabel')"
							data-testid="send-limits-recipient-window"
						>
							<option v-for="option in windowOptions" :key="option.value" :value="option.value">
								{{ option.label }}
							</option>
						</select>
					</div>
					<p v-else class="text-sm text-text-tertiary">
						{{ t('components.apiKeys.sendLimits.perRecipient.offHint') }}
					</p>
				</fieldset>

				<fieldset class="space-y-2">
					<div class="flex items-center justify-between gap-4">
						<legend class="text-sm font-medium text-text-primary">
							{{ t('components.apiKeys.sendLimits.perApiKeyDaily.title') }}
						</legend>
						<UiSwitch
							v-model="form.perApiKeyDaily.isEnabled"
							:label="t('components.apiKeys.sendLimits.perApiKeyDaily.toggle')"
							data-testid="send-limits-daily-switch"
						/>
					</div>
					<div
						v-if="form.perApiKeyDaily.isEnabled"
						class="flex flex-wrap items-center gap-2 text-sm"
					>
						<input
							v-model.number="form.perApiKeyDaily.count"
							type="number"
							step="1"
							:min="bounds.perApiKeyDailyCount.min"
							:max="bounds.perApiKeyDailyCount.max"
							class="input input-sm w-32"
							:aria-label="t('components.apiKeys.sendLimits.perApiKeyDaily.countLabel')"
							data-testid="send-limits-daily-count"
						/>
						<span class="text-text-secondary">
							{{ t('components.apiKeys.sendLimits.perApiKeyDaily.unit') }}
						</span>
					</div>
					<p v-else class="text-sm text-text-tertiary">
						{{ t('components.apiKeys.sendLimits.perApiKeyDaily.offHint') }}
					</p>
				</fieldset>

				<p v-if="problem" class="text-sm text-error" role="alert">{{ problem }}</p>

				<div class="flex flex-wrap items-center justify-between gap-3 pt-1">
					<UiButton variant="ghost" size="sm" type="button" @click="restoreDefaults">
						{{ t('components.apiKeys.sendLimits.restoreDefaults') }}
					</UiButton>
					<div class="flex items-center gap-2">
						<UiButton variant="secondary" size="sm" type="button" @click="isEditing = false">
							{{ t('common.cancel') }}
						</UiButton>
						<UiButton
							size="sm"
							type="submit"
							:disabled="busy || !!problem"
							data-testid="send-limits-save"
						>
							{{ t('common.save') }}
						</UiButton>
					</div>
				</div>
			</form>
		</div>
	</div>
</template>
