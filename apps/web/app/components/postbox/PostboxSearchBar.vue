<script setup lang="ts">
const props = defineProps<{
	modelValue: string;
}>();

const emit = defineEmits<{
	(e: 'update:modelValue', value: string): void;
	(e: 'submit', value: string): void;
}>();

const local = ref(props.modelValue);
watch(
	() => props.modelValue,
	(v) => {
		if (v !== local.value) local.value = v;
	}
);
watch(local, (v) => emit('update:modelValue', v));
const inputEl = ref<HTMLInputElement | null>(null);

function focus() {
	inputEl.value?.focus();
	inputEl.value?.select();
}

function onKeydown(event: KeyboardEvent) {
	if (event.key === 'Enter') {
		event.preventDefault();
		emit('submit', local.value);
	}
}

defineExpose({ focus });
</script>

<template>
	<div class="relative w-full">
		<Icon
			name="lucide:search"
			class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
		/>
		<input
			ref="inputEl"
			v-model="local"
			type="text"
			class="input w-full pl-9 pr-3"
			placeholder="Search mail (from:sara has:attachment older_than:7d…)"
			@keydown="onKeydown"
		/>
	</div>
</template>
