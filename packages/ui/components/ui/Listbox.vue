<script setup lang="ts" generic="T">
/**
 * A list of options to pick from, on Reka UI's listbox: arrow keys, Home/End
 * and type-ahead move the highlight, disabled options are skipped, Enter or a
 * click picks, and the roles, ids and `aria-selected` states come with it.
 *
 * Two ways to drive it:
 *  - Focus inside the list (the default): it is a tab stop of its own.
 *  - `virtual-focus`: focus stays in a text field elsewhere (a combobox input,
 *    a textarea with `@`-mentions, a rich editor). The field forwards its keys
 *    to `handleKeydown` and points at the highlighted option with
 *    `aria-activedescendant` (`activeDescendant`). A press on an option does
 *    not move focus out of the field. Inside `UiCombobox` or
 *    `UiSuggestionPopover` a list is in this mode by itself and attaches to
 *    that field.
 *
 * Options are whatever the caller has; `option-key` names each one, uniquely
 * and stably (it becomes the option's value and part of its id). Selection is
 * by key: `v-model` holds a key, or an array of keys with `multiple`. A list
 * driven by a field with no `v-model` marks the highlighted option selected,
 * as the ARIA combobox pattern does ("selection follows focus").
 *
 * `auto-highlight` keeps an option highlighted at all times (the first one
 * whenever the options change), so Enter always has something to pick: the
 * behaviour of a suggestion list. Without it nothing is highlighted until the
 * keyboard or the pointer goes there.
 */
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { ListboxContent, ListboxItem, ListboxRoot } from 'reka-ui';
import {
	LISTBOX_FIELD_HOST,
	ListboxFieldBridge,
	type DrivenListbox,
	type ListboxFieldControls,
	type ListboxFieldKeys,
} from '../../utils/listboxField';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
	defineProps<{
		options: readonly T[];
		optionKey: (option: T) => string;
		optionDisabled?: (option: T) => boolean;
		/** Names the list for assistive technology. */
		label: string;
		/** Id of the list element; option ids are `<id>-<key>`. */
		id?: string;
		/** Selected key (or keys, with `multiple`). */
		modelValue?: string | string[] | null;
		multiple?: boolean;
		/** Focus stays in a field outside the list (see the component notes). */
		virtualFocus?: boolean;
		/** ↓ on the last option goes back to the first, ↑ on the first to the last. */
		loop?: boolean;
		/** Always keep an option highlighted, the first one when the options change. */
		autoHighlight?: boolean;
		/** Classes for every option (state via `data-[highlighted]`, `data-[state=checked]`). */
		optionClass?: string;
	}>(),
	{
		optionDisabled: undefined,
		id: undefined,
		modelValue: undefined,
		multiple: false,
		virtualFocus: false,
		loop: false,
		autoHighlight: false,
		optionClass: '',
	}
);

const emit = defineEmits<{
	/** An option was picked (Enter, Tab where enabled, or a click). */
	select: [option: T];
	'update:modelValue': [value: string | string[] | undefined];
	/** The highlight moved; null when nothing is highlighted. */
	highlight: [option: T | null];
}>();

defineSlots<{
	option?: (props: { option: T; highlighted: boolean; selected: boolean }) => unknown;
}>();

const host = inject(LISTBOX_FIELD_HOST, null);
const virtual = computed(() => props.virtualFocus || host !== null);

const generatedId = useId();
const listId = computed(() => props.id ?? `ui-listbox-${generatedId}`);

const keyOf = (option: T) => props.optionKey(option);
// Keys are free-form (an emoji shortcode, a Convex id); an id must not hold
// whitespace, which would split `aria-activedescendant`'s IDREF.
const optionId = (key: string) => `${listId.value}-${key.replace(/\s/g, '_')}`;
const isDisabled = (option: T) => props.optionDisabled?.(option) ?? false;

const root = ref<{
	highlightedElement: HTMLElement | null;
	highlightFirstItem: () => void;
	highlightItem: (value: string) => void;
} | null>(null);
const bridge = ref<ListboxFieldControls | null>(null);

const byKey = computed(() => new Map(props.options.map((option) => [keyOf(option), option])));

/** The highlighted option's key, read back from the element Reka highlights. */
const highlightedKey = computed(() => {
	const el = root.value?.highlightedElement;
	return el?.isConnected ? (el.dataset['key'] ?? null) : null;
});

const followsHighlight = computed(
	() => virtual.value && !props.multiple && props.modelValue === undefined
);
const rootValue = computed(() =>
	followsHighlight.value ? (highlightedKey.value ?? undefined) : props.modelValue
);

function isSelected(key: string): boolean {
	const value = rootValue.value;
	return Array.isArray(value) ? value.includes(key) : value === key;
}

function onModelValue(value: unknown) {
	if (followsHighlight.value) return;
	emit('update:modelValue', value as string | string[] | undefined);
}

function onSelect(option: T) {
	if (!isDisabled(option)) emit('select', option);
}

// The last option highlighted: a list that always shows a highlight gets it
// back when the pointer leaves (Reka drops it then, as a menu would);
// otherwise Enter would do nothing.
let lastKey: string | null = null;
watch(highlightedKey, (key) => {
	if (key !== null) lastKey = key;
	emit('highlight', key === null ? null : (byKey.value.get(key) ?? null));
});
function onLeave() {
	if (props.autoHighlight && lastKey !== null && byKey.value.has(lastKey)) {
		root.value?.highlightItem(lastKey);
	}
}

watch(
	() => props.options.map(keyOf).join('\n'),
	async () => {
		await nextTick();
		if (props.autoHighlight && props.options.length > 0) root.value?.highlightFirstItem();
		// The highlighted option went away with the old options: nothing is.
		else if (root.value?.highlightedElement && !root.value.highlightedElement.isConnected) {
			bridge.value?.clear();
		}
	},
	{ immediate: true, flush: 'post' }
);

function onOptionPointermove() {
	bridge.value?.pointing();
}

function onOptionMousedown(event: MouseEvent) {
	// The field keeps focus (and its caret) while an option is clicked.
	if (virtual.value) event.preventDefault();
}

/**
 * A keydown from the field that drives this list (virtual focus only). True
 * when the list handled it; the field then leaves the key alone.
 */
function handleKeydown(event: KeyboardEvent, keys?: ListboxFieldKeys): boolean {
	return bridge.value?.keydown(event, keys) ?? false;
}

/** The highlighted option's id, for the field's `aria-activedescendant`. */
const activeDescendant = computed(() =>
	highlightedKey.value === null ? undefined : optionId(highlightedKey.value)
);

const driven: DrivenListbox = { handleKeydown, activeDescendant, listId };
onMounted(() => {
	if (host) host.list.value = driven;
});
onBeforeUnmount(() => {
	if (host?.list.value === driven) host.list.value = null;
});

defineExpose(driven);
</script>

<template>
	<ListboxRoot
		ref="root"
		:model-value="rootValue"
		:multiple="multiple"
		:loop="loop"
		highlight-on-hover
		:selection-behavior="multiple ? 'toggle' : 'replace'"
		@update:model-value="onModelValue"
		@leave="onLeave"
	>
		<ListboxFieldBridge
			v-if="virtual"
			ref="bridge"
			:empty="options.length === 0"
			:manual="!autoHighlight"
		/>
		<ListboxContent
			v-bind="$attrs"
			:id="listId"
			:aria-label="label"
			class="ui-listbox outline-none"
		>
			<ListboxItem
				v-for="option in options"
				:id="optionId(keyOf(option))"
				:key="keyOf(option)"
				:value="keyOf(option)"
				:data-key="keyOf(option)"
				:disabled="isDisabled(option)"
				class="ui-listbox-option cursor-pointer outline-none data-disabled:cursor-default data-disabled:opacity-50"
				:class="optionClass"
				@select="onSelect(option)"
				@pointermove="onOptionPointermove"
				@mousedown="onOptionMousedown"
			>
				<slot
					name="option"
					:option="option"
					:highlighted="highlightedKey === keyOf(option)"
					:selected="isSelected(keyOf(option))"
				>
					{{ keyOf(option) }}
				</slot>
			</ListboxItem>
		</ListboxContent>
	</ListboxRoot>
</template>
