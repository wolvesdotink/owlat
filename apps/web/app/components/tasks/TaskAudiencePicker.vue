<script setup lang="ts">
/**
 * Who sees a task: Only me (with a lock), Everyone, or one of the viewer's
 * member groups, by name. A row of choices rather than a menu, so it also
 * works inside a popover, where a second floating layer would close the first.
 *
 * Arrow keys move the choice, as in any radio group; only the chosen chip is
 * a Tab stop. `privateDisabledReason` turns Only me off and says why.
 */
import { LockIcon, UsersGroupIcon, UsersIcon, type IconComponent } from '@coolicons/vue';
import type { TaskAudience, TaskGroup } from '~/types/tasks';
import { parseTaskAudienceKey, taskAudienceKey } from '~/utils/taskAudience';

const props = withDefaults(
	defineProps<{
		modelValue: TaskAudience;
		/** The groups the task may be shown to (the viewer's own). */
		groups: readonly TaskGroup[];
		/** Set to switch Only me off, with the sentence that says why. */
		privateDisabledReason?: string | null;
		disabled?: boolean;
		size?: 'sm' | 'md';
	}>(),
	{ privateDisabledReason: null, disabled: false, size: 'sm' }
);
const emit = defineEmits<{ 'update:modelValue': [value: TaskAudience] }>();

const { t } = useI18n();
const reasonId = useId();

interface Choice {
	key: string;
	label: string;
	icon: IconComponent;
	disabled: boolean;
}

const choices = computed<Choice[]>(() => [
	{
		key: 'private',
		label: t('components.tasks.audience.private'),
		icon: LockIcon,
		disabled: props.disabled || !!props.privateDisabledReason,
	},
	{
		key: 'everyone',
		label: t('components.tasks.audience.everyone'),
		icon: UsersIcon,
		disabled: props.disabled,
	},
	...props.groups.map((group) => ({
		key: `group:${group._id}`,
		label: group.name,
		icon: UsersGroupIcon,
		disabled: props.disabled || !group.isMember,
	})),
]);

const selectedKey = computed(() => taskAudienceKey(props.modelValue));
const buttons = ref<HTMLButtonElement[]>([]);

function choose(choice: Choice) {
	if (choice.disabled || choice.key === selectedKey.value) return;
	const audience = parseTaskAudienceKey(choice.key);
	if (audience) emit('update:modelValue', audience);
}

function move(delta: 1 | -1) {
	const enabled = choices.value.filter((c) => !c.disabled);
	if (enabled.length === 0) return;
	const index = enabled.findIndex((c) => c.key === selectedKey.value);
	const next = enabled[(index + delta + enabled.length) % enabled.length]!;
	choose(next);
	void nextTick(() => {
		const at = choices.value.findIndex((c) => c.key === next.key);
		buttons.value[at]?.focus();
	});
}

function onKeydown(event: KeyboardEvent) {
	if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
		event.preventDefault();
		move(1);
	} else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
		event.preventDefault();
		move(-1);
	}
}

/** The chip that holds the Tab stop: the chosen one, else the first that can be chosen. */
const tabStopKey = computed(() => {
	const selected = choices.value.find((c) => c.key === selectedKey.value && !c.disabled);
	return selected?.key ?? choices.value.find((c) => !c.disabled)?.key ?? null;
});
</script>

<template>
	<div>
		<div
			role="radiogroup"
			:aria-label="t('components.tasks.audience.label')"
			:aria-describedby="privateDisabledReason ? reasonId : undefined"
			class="flex flex-wrap items-center gap-1"
			data-testid="task-audience-picker"
			@keydown="onKeydown"
		>
			<button
				v-for="(choice, index) in choices"
				:key="choice.key"
				:ref="(el) => (buttons[index] = el as HTMLButtonElement)"
				type="button"
				role="radio"
				:aria-checked="choice.key === selectedKey"
				:aria-disabled="choice.disabled || undefined"
				:tabindex="choice.key === tabStopKey ? 0 : -1"
				:data-audience="choice.key"
				class="inline-flex max-w-48 items-center gap-1 rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-brand"
				:class="[
					size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm',
					choice.key === selectedKey
						? 'border-brand-border bg-brand-soft font-medium text-brand'
						: 'border-border-subtle text-text-secondary',
					choice.disabled
						? 'cursor-not-allowed opacity-50'
						: choice.key === selectedKey
							? ''
							: 'hover:bg-bg-surface hover:text-text-primary',
				]"
				@click="choose(choice)"
			>
				<component :is="choice.icon" class="size-3.5 shrink-0" aria-hidden="true" />
				<span class="truncate">{{ choice.label }}</span>
			</button>
		</div>
		<p v-if="privateDisabledReason" :id="reasonId" class="mt-1 text-2xs text-text-tertiary">
			{{ privateDisabledReason }}
		</p>
	</div>
</template>
