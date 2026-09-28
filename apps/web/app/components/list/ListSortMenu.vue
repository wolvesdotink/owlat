<script setup lang="ts">
/**
 * The sort dropdown of a dashboard list page: an outline trigger that names the
 * current order, and a listbox of the options.
 *
 * The marketing and transactional lists each carried a copy of this markup and
 * closed it differently — one through `useClickOutsideSelector`, the other with
 * its own document listener. One copy now, closed the one way.
 */
import type { ListSortOption } from '~/composables/useListPage';

const props = defineProps<{
	options: readonly ListSortOption[];
	/** The selected option's `value`. */
	modelValue: string;
	/** Accessible name for the trigger and the listbox ("Sort templates"). */
	label: string;
	/** Id of the listbox, referenced by the trigger's `aria-controls`. */
	listboxId: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const { t } = useI18n();

const isOpen = ref(false);
const current = computed(
	() => props.options.find((option) => option.value === props.modelValue) ?? props.options[0]
);

const select = (value: string) => {
	emit('update:modelValue', value);
	isOpen.value = false;
};

useClickOutsideSelector('[data-sort-dropdown]', () => {
	isOpen.value = false;
});
</script>

<template>
	<div class="relative" data-sort-dropdown>
		<UiButton
			variant="outline"
			size="sm"
			aria-haspopup="listbox"
			:aria-expanded="isOpen"
			:aria-controls="listboxId"
			:aria-label="label"
			@click="isOpen = !isOpen"
		>
			<template #iconLeft>
				<Icon name="lucide:arrow-up-down" class="w-4 h-4" />
			</template>
			<span v-if="current" class="hidden sm:inline">{{ t(current.label) }}</span>
			<template #iconRight>
				<Icon name="lucide:chevron-down" class="w-4 h-4" />
			</template>
		</UiButton>
		<Transition
			enter-active-class="duration-(--motion-moderate) ease-spring"
			enter-from-class="opacity-0 scale-95"
			enter-to-class="opacity-100 scale-100"
			leave-active-class="duration-(--motion-moderate-exit) ease-exit"
			leave-from-class="opacity-100 scale-100"
			leave-to-class="opacity-0 scale-95"
		>
			<div
				v-if="isOpen"
				:id="listboxId"
				role="listbox"
				:aria-label="label"
				class="absolute right-0 top-full mt-1 w-44 bg-bg-elevated border border-border-subtle rounded-lg shadow-lg z-20 py-1"
			>
				<button
					v-for="option in options"
					:key="option.value"
					type="button"
					role="option"
					:aria-selected="modelValue === option.value"
					:class="[
						'w-full px-3 py-2 text-left text-sm transition-colors flex items-center justify-between focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset',
						modelValue === option.value
							? 'text-brand bg-brand/5'
							: 'text-text-primary hover:bg-bg-surface',
					]"
					@click="select(option.value)"
				>
					{{ t(option.label) }}
					<Icon v-if="modelValue === option.value" name="lucide:check" class="w-4 h-4" />
				</button>
			</div>
		</Transition>
	</div>
</template>
