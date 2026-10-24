/**
 * Lets a text field outside a Reka listbox drive it while keeping focus: the
 * combobox pattern, where the person types into an input, a textarea or a
 * contenteditable, the arrow keys move a highlight through the options, and
 * the field names that option with `aria-activedescendant`.
 *
 * Reka ships this for a plain `<input>` (`ListboxFilter`), but that component
 * also owns the input's value, which a textarea with `@`-mentions or a rich
 * editor cannot hand over. This bridge takes only the part that matters: it
 * turns the options' own focus off and forwards navigation and selection keys
 * to the listbox's context. Renders nothing; mount it inside `ListboxRoot`.
 */
import {
	defineComponent,
	onBeforeUnmount,
	watch,
	type ComputedRef,
	type InjectionKey,
	type Ref,
	type ShallowRef,
} from 'vue';
import { injectListboxRootContext } from 'reka-ui';

/** Keys a particular field hands to the list, beyond ↑ ↓ and Enter. */
export interface ListboxFieldKeys {
	/** Home and End jump to the first and last option (an input searching a list). */
	homeEnd?: boolean;
	/** Tab picks the highlighted option (inline suggestions). */
	tab?: boolean;
}

export interface ListboxFieldControls {
	/** The highlighted option's element, or null. */
	highlighted: Ref<HTMLElement | null>;
	/** Handles a keydown from the field; true when the list consumed it. */
	keydown: (event: KeyboardEvent, keys?: ListboxFieldKeys) => boolean;
	/** Drops the highlight (the options it pointed at are gone). */
	clear: () => void;
	/** The pointer is moving onto an option: let it take the highlight. */
	pointing: () => void;
}

const NAVIGATION = new Set(['ArrowDown', 'ArrowUp']);
const JUMPS = new Set(['Home', 'End']);

/** An IME is composing: its Enter confirms a candidate, its arrows pick one. */
function composing(event: KeyboardEvent): boolean {
	return event.isComposing || event.keyCode === 229;
}

export const ListboxFieldBridge = defineComponent({
	name: 'ListboxFieldBridge',
	props: {
		/** No options to move through: the keys stay the field's (↑ moves the caret). */
		empty: { type: Boolean, default: false },
		/**
		 * Only the person moves the highlight. Reka highlights the selected (or
		 * first) option by itself when the list mounts or the selection changes;
		 * a search field that should not pre-pick anything turns that off here.
		 */
		manual: { type: Boolean, default: false },
	},
	setup(props, { expose }) {
		const context = injectListboxRootContext();
		// The options never take focus: it stays in the field.
		context.focusable.value = false;
		onBeforeUnmount(() => {
			context.focusable.value = true;
		});

		// Whether the next highlight comes from the person (a key, the pointer).
		let intended = false;
		watch(
			context.highlightedElement,
			(el) => {
				const wanted = intended;
				intended = false;
				if (!el || !props.manual || wanted) return;
				// Reka is still inside its highlight (it scrolls the option into view
				// next), so the highlight is taken back once it is done.
				queueMicrotask(() => {
					if (context.highlightedElement.value === el) context.highlightedElement.value = null;
				});
			},
			{ flush: 'sync' }
		);

		function keydown(event: KeyboardEvent, keys: ListboxFieldKeys = {}): boolean {
			if (props.empty || composing(event) || event.altKey || event.ctrlKey || event.metaKey) {
				return false;
			}
			if (NAVIGATION.has(event.key) || (keys.homeEnd && JUMPS.has(event.key))) {
				event.preventDefault();
				intended = true;
				// Reka reverses the options for End only from a highlighted one;
				// from none it would land on the first. Start it at the first.
				if (event.key === 'End' && !context.highlightedElement.value) {
					context.onKeydownNavigation(new KeyboardEvent('keydown', { key: 'Home' }));
					intended = true;
				}
				context.onKeydownNavigation(event);
				intended = false;
				return true;
			}
			const picks = event.key === 'Enter' || (keys.tab === true && event.key === 'Tab');
			if (!picks || event.shiftKey) return false;
			const option = context.highlightedElement.value;
			if (!option?.isConnected || option.hasAttribute('data-disabled')) return false;
			event.preventDefault();
			option.click();
			return true;
		}

		const controls: ListboxFieldControls = {
			highlighted: context.highlightedElement,
			keydown,
			clear: () => {
				context.highlightedElement.value = null;
			},
			pointing: () => {
				// Reka's own pointermove handler runs right after the caller's.
				intended = true;
				queueMicrotask(() => {
					intended = false;
				});
			},
		};
		expose(controls);
		return () => null;
	},
});

/** What a listbox driven by a field offers that field. */
export interface DrivenListbox {
	handleKeydown: (event: KeyboardEvent, keys?: ListboxFieldKeys) => boolean;
	/** The highlighted option's id, for `aria-activedescendant`. */
	activeDescendant: ComputedRef<string | undefined>;
	listId: ComputedRef<string>;
}

/**
 * Provided by a field that drives whichever `UiListbox` renders inside it
 * (`UiCombobox`, `UiSuggestionPopover`): the list attaches itself here, so the
 * caller can lay the list out (inside a loading boundary, under a header)
 * without wiring refs by hand.
 */
export interface ListboxFieldHost {
	list: ShallowRef<DrivenListbox | null>;
}

/**
 * What a suggestion list (`UiSuggestionPopover`, and the pickers built on it)
 * hands the field it serves: its keys first, then ARIA naming the list and
 * the highlighted option.
 */
export interface SuggestionListHandle {
	handleKeydown: (event: KeyboardEvent) => boolean;
	fieldAttrs: Record<string, unknown>;
}

export const LISTBOX_FIELD_HOST: InjectionKey<ListboxFieldHost> = Symbol('ui-listbox-field-host');
