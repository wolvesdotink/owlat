<script setup lang="ts">
/**
 * Pickable agent draft options at the review gate.
 *
 * The `draft` Agent step offers 2–3 diverse drafts (concise / hedged / detailed)
 * on low-confidence / low-quality cases (apps/api/convex/agent/steps/draft).
 * This presentational radiogroup renders them and two-way-binds the selected
 * index via `v-model`; the parent (review.vue) owns the Approve/Edit/Reject
 * actions and approves whichever option is selected. `options[0]` is always the
 * primary self-checked draft, so a selection of 0 (the default) approves it
 * unchanged.
 */
const props = defineProps<{
	/** The pickable draft variants; index 0 is the primary draft. */
	options: string[];
	/** Selected index (v-model). */
	modelValue: number;
}>();

const emit = defineEmits<{ 'update:modelValue': [index: number] }>();

const selected = computed({
	get: () => props.modelValue,
	set: (i: number) => emit('update:modelValue', i),
});
</script>

<template>
	<div class="bg-brand-subtle/30 rounded-lg p-4">
		<div class="flex items-center gap-2 mb-3">
			<Icon name="lucide:bot" class="w-4 h-4 text-brand" />
			<p class="text-xs font-medium text-brand uppercase tracking-wider">Agent Draft — pick one</p>
		</div>
		<div role="radiogroup" aria-label="Draft options" class="flex flex-col gap-2">
			<label
				v-for="(option, i) in options"
				:key="i"
				class="flex items-start gap-2 rounded-md border p-3 cursor-pointer transition-colors"
				:class="selected === i ? 'border-brand bg-brand-subtle/40' : 'border-border hover:border-brand/50'"
			>
				<input
					type="radio"
					class="mt-1"
					:value="i"
					:checked="selected === i"
					@change="selected = i"
				/>
				<span class="text-text-primary text-sm whitespace-pre-wrap">{{ option }}</span>
			</label>
		</div>
	</div>
</template>
