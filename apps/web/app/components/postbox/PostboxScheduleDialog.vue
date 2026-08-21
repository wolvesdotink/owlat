<script setup lang="ts">
const { t, locale } = useI18n();

const props = defineProps<{
	open: boolean;
}>();

const emit = defineEmits<{
	(e: 'update:open', value: boolean): void;
	(e: 'confirm', timestamp: number): void;
}>();

function nextOccurrence(hour: number, dayOffset = 0): number {
	const d = new Date();
	d.setDate(d.getDate() + dayOffset);
	d.setHours(hour, 0, 0, 0);
	return d.getTime();
}

/** The preset's clock time, written the way the reader's locale writes it. */
function formatHour(hour: number): string {
	const d = new Date();
	d.setHours(hour, 0, 0, 0);
	return new Intl.DateTimeFormat(locale.value, { hour: 'numeric', minute: '2-digit' }).format(d);
}

const PRESETS = computed(() => {
	const now = new Date();
	const items: Array<{ label: string; when: () => number; sub: string }> = [
		{
			label: t('components.postbox.postboxScheduleDialog.tomorrowMorning'),
			sub: formatHour(9),
			when: () => nextOccurrence(9, 1),
		},
		{
			label: t('components.postbox.postboxScheduleDialog.tomorrowAfternoon'),
			sub: formatHour(13),
			when: () => nextOccurrence(13, 1),
		},
	];
	const dow = now.getDay();
	const toMon = (1 + 7 - dow) % 7 || 7;
	items.push({
		label: t('components.postbox.postboxScheduleDialog.mondayMorning'),
		sub: formatHour(9),
		when: () => nextOccurrence(9, toMon),
	});
	return items;
});

const customDate = ref('');

function close() {
	emit('update:open', false);
}
function pickPreset(p: { when: () => number }) {
	emit('confirm', p.when());
	close();
}
function pickCustom() {
	if (!customDate.value) return;
	const ts = new Date(customDate.value).getTime();
	if (Number.isNaN(ts) || ts <= Date.now()) return;
	emit('confirm', ts);
	close();
}
</script>

<template>
	<UiModal
		:open="open"
		:title="t('components.postbox.postboxScheduleDialog.title')"
		size="sm"
		@update:open="
			(v) => {
				if (!v) close();
			}
		"
	>
		<ul class="space-y-1 mb-4">
			<li v-for="preset in PRESETS" :key="preset.label">
				<button
					type="button"
					class="w-full flex items-center justify-between px-3 py-2 rounded hover:bg-bg-surface text-left text-sm"
					@click="pickPreset(preset)"
				>
					<span class="font-medium">{{ preset.label }}</span>
					<span class="text-text-tertiary">{{ preset.sub }}</span>
				</button>
			</li>
		</ul>
		<div class="border-t border-border-subtle pt-3">
			<label class="text-xs font-medium text-text-tertiary block mb-1">{{
				t('components.postbox.postboxScheduleDialog.custom')
			}}</label>
			<div class="flex items-center gap-2">
				<input v-model="customDate" type="datetime-local" class="input flex-1" />
				<UiButton type="button" :disabled="!customDate" @click="pickCustom">
					{{ t('components.postbox.postboxScheduleDialog.schedule') }}
				</UiButton>
			</div>
		</div>
	</UiModal>
</template>
