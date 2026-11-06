<script setup lang="ts">
/**
 * Who owns a task. Offers only `options`, the members the task's audience
 * allows (`taskAssigneeOptions` in utils/taskAudience.ts), the viewer first as
 * "Me". The list opens in place under the button, with a search field, so
 * the picker also works inside a popover.
 *
 * `disabledReason` keeps the picker shut and says why (an Only me task stays
 * with its creator).
 */
import { CheckIcon, ChevronDownIcon } from '@coolicons/vue';
import { useEscapeLayer } from '@owlat/ui/composables/useEscapeLayer';
import type { TaskMember } from '~/types/tasks';

const props = withDefaults(
	defineProps<{
		modelValue: string;
		options: readonly TaskMember[];
		viewerId: string | null;
		/** A member the options may not list (the roster is loading, or they left). */
		fallbackName?: string;
		disabledReason?: string | null;
		size?: 'sm' | 'md';
	}>(),
	{ fallbackName: '', disabledReason: null, size: 'sm' }
);
const emit = defineEmits<{ 'update:modelValue': [userId: string] }>();

const { t } = useI18n();
const isOpen = ref(false);
const query = ref('');
const inputId = useId();
const reasonId = useId();

const selected = computed(() => props.options.find((m) => m.userId === props.modelValue) ?? null);

function labelOf(member: TaskMember): string {
	if (member.userId === props.viewerId) return t('components.tasks.assignee.me');
	return member.name?.trim() || member.email;
}
const triggerLabel = computed(() => {
	if (props.modelValue === props.viewerId) return t('components.tasks.assignee.me');
	if (selected.value) return labelOf(selected.value);
	return props.fallbackName || t('components.tasks.people.someone');
});

const shown = computed(() => {
	const words = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [...props.options];
	return props.options.filter((m) => {
		const haystack = `${m.name ?? ''} ${m.email} ${labelOf(m)}`.toLowerCase();
		return words.every((word) => haystack.includes(word));
	});
});

function toggle() {
	if (props.disabledReason) return;
	isOpen.value = !isOpen.value;
	query.value = '';
	if (isOpen.value) {
		void nextTick(() => document.getElementById(inputId)?.focus());
	}
}
function pick(member: TaskMember) {
	emit('update:modelValue', member.userId);
	isOpen.value = false;
}
useEscapeLayer(isOpen, () => {
	isOpen.value = false;
});
</script>

<template>
	<div class="min-w-0">
		<button
			type="button"
			class="inline-flex max-w-56 items-center gap-1.5 rounded-full border border-border-subtle text-text-secondary transition-colors hover:bg-bg-surface hover:text-text-primary focus-visible:outline-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
			:class="size === 'sm' ? 'py-0.5 pl-0.5 pr-2 text-xs' : 'py-1 pl-1 pr-2.5 text-sm'"
			:disabled="!!disabledReason"
			:aria-expanded="isOpen"
			:aria-label="t('components.tasks.assignee.label', { name: triggerLabel })"
			:aria-describedby="disabledReason ? reasonId : undefined"
			data-testid="task-assignee-picker"
			@click="toggle"
		>
			<UiAvatar
				:name="selected?.name ?? fallbackName ?? null"
				:email="selected?.email ?? null"
				:image="selected?.image ?? null"
				deterministic-color
				size="xs"
			/>
			<span class="truncate">{{ triggerLabel }}</span>
			<ChevronDownIcon v-if="!disabledReason" class="size-3 shrink-0" aria-hidden="true" />
		</button>
		<p v-if="disabledReason" :id="reasonId" class="mt-1 text-2xs text-text-tertiary">
			{{ disabledReason }}
		</p>
		<div
			v-if="isOpen"
			class="mt-1.5 w-full max-w-72 rounded-lg border border-border-subtle bg-bg-elevated p-1 shadow-(--shadow-2)"
		>
			<UiCombobox
				v-model:query="query"
				:input-id="inputId"
				:options="shown"
				:option-key="(m: TaskMember) => m.userId"
				:model-value="modelValue"
				:label="t('components.tasks.assignee.listLabel')"
				:placeholder="t('components.tasks.assignee.search')"
				input-class="input input-sm w-full"
				inline
				auto-highlight
				list-class="mt-1 max-h-48 overflow-y-auto"
				option-class="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-text-primary data-highlighted:bg-bg-surface"
				@select="pick"
			>
				<template #option="{ option, selected: isSelected }">
					<UiAvatar
						:name="option.name"
						:email="option.email"
						:image="option.image"
						deterministic-color
						size="xs"
					/>
					<span class="min-w-0 flex-1 truncate">{{ labelOf(option) }}</span>
					<CheckIcon v-if="isSelected" class="size-3.5 shrink-0 text-brand" aria-hidden="true" />
				</template>
			</UiCombobox>
			<p v-if="shown.length === 0" class="px-2 py-1.5 text-xs text-text-tertiary">
				{{ t('components.tasks.assignee.noMatch') }}
			</p>
		</div>
	</div>
</template>
