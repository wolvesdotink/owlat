<script setup lang="ts">
import { computed, ref } from 'vue';
import { TriangleAlert } from '@lucide/vue';

const props = defineProps<{
	value: string;
	/** Whether the block is explicitly marked as decorative (intentional empty alt) */
	decorative?: boolean;
	placeholder?: string;
}>();

const emit = defineEmits<{
	(e: 'update', value: string): void;
	(e: 'mark-decorative'): void;
}>();

const inputRef = ref<HTMLInputElement | null>(null);

/**
 * Empty alt on a non-decorative image is the single most common accessibility
 * defect in email — the renderer's audit flags it, so surface it right here
 * instead of leaving the author to find it in the preview's validation tab.
 */
const showNudge = computed(() => !props.decorative && props.value.trim() === '');

function handleInput(event: Event) {
	emit('update', (event.target as HTMLInputElement).value);
}

function focusInput() {
	inputRef.value?.focus();
}
</script>

<template>
	<div class="flex flex-col gap-[5px]">
		<input
			ref="inputRef"
			type="text"
			aria-label="Alternative text"
			class="w-full py-2 px-2.5 text-[13px] border rounded-lg bg-bg-surface text-text-primary outline-none eb-input-ring placeholder:text-text-disabled"
			:class="showNudge ? 'border-warning/50' : 'border-border-subtle'"
			:value="value"
			:placeholder="placeholder"
			@input="handleInput"
		/>

		<div
			v-if="showNudge"
			role="status"
			class="flex flex-col gap-1.5 py-2 px-2.5 rounded-lg border border-warning/20 bg-warning/10"
		>
			<div class="flex items-start gap-1.5">
				<TriangleAlert :size="13" class="shrink-0 mt-px text-warning" />
				<p class="text-[11px] leading-[1.4] text-text-secondary m-0">
					Missing alt text — screen readers will skip this image
				</p>
			</div>
			<div class="flex items-center gap-1.5">
				<button
					type="button"
					class="py-1 px-2 rounded-md text-[11px] font-medium border border-border-subtle bg-bg-surface text-text-primary cursor-pointer transition-colors duration-(--motion-fast) hover:bg-bg-surface-hover"
					@click="focusInput"
				>
					Add alt text
				</button>
				<button
					type="button"
					class="py-1 px-2 rounded-md text-[11px] font-medium border border-transparent bg-transparent text-text-secondary cursor-pointer transition-colors duration-(--motion-fast) hover:bg-bg-surface-hover hover:text-text-primary"
					@click="emit('mark-decorative')"
				>
					Mark decorative
				</button>
			</div>
		</div>
	</div>
</template>
