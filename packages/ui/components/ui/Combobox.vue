<script setup lang="ts" generic="T">
/**
 * A search input over a list of options: the ARIA combobox. Focus stays in the
 * input; ↑ ↓ (and Home/End) move the highlight through the list, Enter picks
 * it, and the input names the highlighted option with `aria-activedescendant`.
 * The list is a `UiListbox` (Reka UI underneath).
 *
 * The caller owns the results: it filters, ranks or searches on the server
 * from `v-model:query` and passes back `options`. Nothing here filters.
 *
 * `inline` keeps the list under the input at all times (a picker that is the
 * whole surface); otherwise it opens in a `UiPopover` under the input when the
 * person types or presses ↓, and closes on Escape, an outside press, or a pick
 * (unless `stay-open`, for picking several in a row).
 *
 * The default slot replaces the built-in list when the surface needs more
 * around it (a loading boundary, a "load more" row): put a `UiListbox` in it
 * and it attaches to this input by itself.
 */
import { computed, ref, shallowRef, provide, useSlots, type ShallowRef } from 'vue';
import UiListbox from './Listbox.vue';
import UiPopover from './Popover.vue';
import { LISTBOX_FIELD_HOST, type DrivenListbox } from '../../utils/listboxField';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
	defineProps<{
		/** The results to show (already filtered by the caller). */
		options?: readonly T[];
		optionKey?: (option: T) => string;
		optionDisabled?: (option: T) => boolean;
		/** Names the list for assistive technology. */
		label: string;
		inputId?: string;
		placeholder?: string;
		/** Selected key (or keys, with `multiple`). */
		modelValue?: string | string[] | null;
		multiple?: boolean;
		/** The list stays under the input instead of opening in a popover. */
		inline?: boolean;
		/** Keep the first option highlighted, so Enter picks the top result. */
		autoHighlight?: boolean;
		/** Leave the popover open after a pick (several picks in a row). */
		stayOpen?: boolean;
		inputClass?: string;
		listClass?: string;
		optionClass?: string;
		/** `data-testid` of the input. */
		inputTestid?: string;
	}>(),
	{
		options: () => [],
		optionKey: (option: T) => String(option),
		optionDisabled: undefined,
		inputId: undefined,
		placeholder: undefined,
		modelValue: undefined,
		multiple: false,
		inline: false,
		autoHighlight: false,
		stayOpen: false,
		inputClass: 'input w-full',
		listClass: '',
		optionClass: '',
		inputTestid: undefined,
	}
);

const query = defineModel<string>('query', { default: '' });
const open = defineModel<boolean>('open', { default: false });

const emit = defineEmits<{
	select: [option: T];
	'update:modelValue': [value: string | string[] | undefined];
	highlight: [option: T | null];
}>();

defineSlots<{
	/** Inside the input box, before the text (a search icon). */
	leading?: () => unknown;
	option?: (props: { option: T; highlighted: boolean; selected: boolean }) => unknown;
	/** Replaces the built-in list (see the component notes). */
	default?: () => unknown;
	/** Shown in the popover when there are no options. */
	empty?: () => unknown;
}>();

const slots = useSlots();
const input = ref<HTMLInputElement | null>(null);
const list: ShallowRef<DrivenListbox | null> = shallowRef(null);
provide(LISTBOX_FIELD_HOST, { list });

/** Whether the popover has anything to show. */
const hasContent = computed(
	() => !!slots['default'] || props.options.length > 0 || !!slots['empty']
);
const expanded = computed(() => props.inline || (open.value && hasContent.value));

const activeDescendant = computed(() =>
	expanded.value ? list.value?.activeDescendant.value : undefined
);

function onInput() {
	if (!props.inline) open.value = true;
}

function onSelect(option: T) {
	emit('select', option);
	if (!props.inline && !props.stayOpen) open.value = false;
}

function onKeydown(event: KeyboardEvent) {
	// A closed popover opens on ↓ (or ↑); the next press moves through it.
	if (!props.inline && !open.value && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
		event.preventDefault();
		open.value = true;
		return;
	}
	if (expanded.value && list.value?.handleKeydown(event, { homeEnd: true })) return;
	// Enter in a search box never submits the form around it.
	if (event.key === 'Enter') {
		event.preventDefault();
		return;
	}
	// The open popover takes Escape first (its escape layer); an inline list's
	// Escape clears the search.
	if (event.key === 'Escape' && props.inline && query.value) {
		event.preventDefault();
		query.value = '';
	}
}
</script>

<template>
	<div v-bind="$attrs">
		<div class="relative">
			<slot name="leading" />
			<input
				:id="inputId"
				ref="input"
				v-model="query"
				type="text"
				role="combobox"
				aria-autocomplete="list"
				:aria-expanded="expanded"
				:aria-controls="expanded ? list?.listId.value : undefined"
				:aria-activedescendant="activeDescendant"
				autocomplete="off"
				:placeholder="placeholder"
				:class="inputClass"
				:data-testid="inputTestid"
				@input="onInput"
				@keydown="onKeydown"
			/>
		</div>
		<slot v-if="inline">
			<UiListbox
				:options="options"
				:option-key="optionKey"
				:option-disabled="optionDisabled"
				:label="label"
				:model-value="modelValue"
				:multiple="multiple"
				:auto-highlight="autoHighlight"
				:class="listClass"
				:option-class="optionClass"
				@select="onSelect"
				@highlight="emit('highlight', $event)"
				@update:model-value="emit('update:modelValue', $event)"
			>
				<template v-if="$slots['option']" #option="scope">
					<slot name="option" v-bind="scope" />
				</template>
			</UiListbox>
		</slot>
		<UiPopover
			v-else
			:open="expanded"
			:anchor="input"
			:focus="false"
			:inside="[input]"
			match-anchor-width
			@update:open="open = $event"
		>
			<slot>
				<UiListbox
					v-if="options.length > 0"
					:options="options"
					:option-key="optionKey"
					:option-disabled="optionDisabled"
					:label="label"
					:model-value="modelValue"
					:multiple="multiple"
					:auto-highlight="autoHighlight"
					:class="listClass"
					:option-class="optionClass"
					@select="onSelect"
					@highlight="emit('highlight', $event)"
					@update:model-value="emit('update:modelValue', $event)"
				>
					<template v-if="$slots['option']" #option="scope">
						<slot name="option" v-bind="scope" />
					</template>
				</UiListbox>
				<slot v-else name="empty" />
			</slot>
		</UiPopover>
	</div>
</template>
