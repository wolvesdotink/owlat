<script setup lang="ts">
/**
 * "Remind me if no reply by…" preset picker — same menu style as
 * PostboxSnoozeDialog. Used by the composer footer toggle (stores the
 * deadline on the draft) and by the reader/sent-list to arm a follow-up
 * on an already-sent message.
 */
defineProps<{
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

const PRESETS = computed(() => {
	const dow = new Date().getDay();
	return [
		{ label: 'Tomorrow', sub: '9:00 AM', when: () => nextOccurrence(9, 1) },
		{ label: 'In 3 days', sub: '9:00 AM', when: () => nextOccurrence(9, 3) },
		{
			label: 'Next week',
			sub: 'Mon 9:00 AM',
			when: () => nextOccurrence(9, (8 - dow) % 7 || 7),
		},
	];
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
	<UiModal :open="open" title="Remind me if no reply by" size="sm" @update:open="(v) => { if (!v) close(); }">
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
				<label class="text-xs font-medium text-text-tertiary block mb-1">Custom</label>
				<div class="flex items-center gap-2">
					<input
						v-model="customDate"
						type="datetime-local"
						class="input flex-1"
					/>
					<button
						type="button"
						class="btn btn-primary"
						:disabled="!customDate"
						@click="pickCustom"
					>
						Remind me
					</button>
				</div>
			</div>
	</UiModal>
</template>
