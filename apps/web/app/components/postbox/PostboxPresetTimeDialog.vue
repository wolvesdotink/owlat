<script setup lang="ts">
/**
 * Shared preset-time picker modal. A titled list of quick presets plus a
 * custom `datetime-local` row; emits `confirm` with the chosen epoch-ms.
 * Reused by PostboxSnoozeDialog (snooze until) and PostboxFollowUpDialog
 * (remind me if no reply by) — each supplies its own title, preset set and
 * confirm-button label so only the picker chrome lives here.
 */
export interface PresetTimeOption {
	label: string;
	sub: string;
	/** Resolves the preset to an absolute epoch-ms at click time. */
	when: () => number;
	/** Badge this row as the content-inferred suggestion. */
	suggested?: boolean;
}

/** A non-timestamp action rendered below the presets (e.g. "Until they reply"). */
export interface PresetTimeAction {
	id: string;
	label: string;
	sub: string;
}

const props = withDefaults(
	defineProps<{
		open: boolean;
		title: string;
		presets: PresetTimeOption[];
		confirmLabel: string;
		/** Extra non-timestamp options; picking one emits `action` with its id. */
		actions?: PresetTimeAction[];
	}>(),
	{ actions: () => [] }
);

const emit = defineEmits<{
	(e: 'update:open', value: boolean): void;
	(e: 'confirm', timestamp: number): void;
	(e: 'action', id: string): void;
}>();

const { t } = useI18n();

const customDate = ref('');
const customInputId = useId();
const customErrorId = useId();

// The clock the custom value is checked against. It is re-read when the
// dialog opens, on every edit and on confirm: `min` on the native picker is
// only a hint, so a past time still has to say why it cannot be used.
const validationNow = ref(Date.now());
watch(
	() => props.open,
	(open) => {
		if (open) validationNow.value = Date.now();
	}
);
watch(customDate, () => {
	validationNow.value = Date.now();
});

/** `YYYY-MM-DDTHH:mm` in the local clock: the picker's floor, this minute. */
const customMin = computed(() => {
	const local = new Date(
		validationNow.value - new Date(validationNow.value).getTimezoneOffset() * 60_000
	);
	return local.toISOString().slice(0, 16);
});

/** A value is there but it is not a future time. */
const customInvalid = computed(() => {
	if (!customDate.value) return false;
	const ts = new Date(customDate.value).getTime();
	return Number.isNaN(ts) || ts <= validationNow.value;
});

function close() {
	emit('update:open', false);
}

function pickPreset(p: PresetTimeOption) {
	emit('confirm', p.when());
	close();
}

function pickAction(id: string) {
	emit('action', id);
	close();
}

function pickCustom() {
	if (!customDate.value) return;
	validationNow.value = Date.now();
	const ts = new Date(customDate.value).getTime();
	if (Number.isNaN(ts) || ts <= validationNow.value) return;
	emit('confirm', ts);
	close();
}
</script>

<template>
	<UiModal
		:open="open"
		:title="title"
		size="sm"
		@update:open="
			(v) => {
				if (!v) close();
			}
		"
	>
		<!-- Optional chrome above the presets (PostboxSnoozeDialog puts its
		     thread/message scope toggle here). Renders nothing when unused. -->
		<slot name="beforePresets" />
		<ul class="space-y-1 mb-4">
			<li v-for="preset in presets" :key="preset.label">
				<button
					type="button"
					class="w-full flex items-center justify-between px-3 py-2 rounded hover:bg-bg-surface text-left text-sm"
					@click="pickPreset(preset)"
				>
					<span class="font-medium flex items-center gap-2">
						{{ preset.label }}
						<span
							v-if="preset.suggested"
							class="text-2xs uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border border-border-subtle text-brand"
							>{{ t('components.postbox.postboxPresetTimeDialog.suggested') }}</span
						>
					</span>
					<span class="text-text-tertiary">{{ preset.sub }}</span>
				</button>
			</li>
			<li v-for="action in actions" :key="action.id">
				<button
					type="button"
					class="w-full flex items-center justify-between px-3 py-2 rounded hover:bg-bg-surface text-left text-sm"
					@click="pickAction(action.id)"
				>
					<span class="font-medium">{{ action.label }}</span>
					<span class="text-text-tertiary">{{ action.sub }}</span>
				</button>
			</li>
		</ul>
		<div class="border-t border-border-subtle pt-3">
			<label :for="customInputId" class="text-xs font-medium text-text-tertiary block mb-1">
				{{ t('components.postbox.postboxPresetTimeDialog.custom') }}
			</label>
			<div class="flex items-center gap-2">
				<input
					:id="customInputId"
					v-model="customDate"
					type="datetime-local"
					class="input flex-1"
					:min="customMin"
					:aria-invalid="customInvalid ? 'true' : undefined"
					:aria-describedby="customInvalid ? customErrorId : undefined"
				/>
				<UiButton type="button" :disabled="!customDate || customInvalid" @click="pickCustom">
					{{ confirmLabel }}
				</UiButton>
			</div>
			<p v-if="customInvalid" :id="customErrorId" class="text-xs mt-1.5 text-error" role="alert">
				{{ t('components.postbox.postboxPresetTimeDialog.customPast') }}
			</p>
		</div>
	</UiModal>
</template>
