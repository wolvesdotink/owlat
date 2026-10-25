/**
 * Reading a control's UiTooltip in a component suite.
 *
 * `tooltipOf` is the text a control's tooltip carries, read from the UiTooltip
 * around it (its root element is the control itself). `focusTooltip` is what a
 * person reads: it focuses the control, takes the open bubble's text and
 * shortcut, and blurs again. It needs the wrapper attached to the document.
 */
import type { DOMWrapper, VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

export function tooltipOf(
	wrapper: VueWrapper,
	control: DOMWrapper<Element> | Element
): string | undefined {
	const element = control instanceof Element ? control : control.element;
	const tooltip = wrapper
		.findAllComponents({ name: 'UiTooltip' })
		.find((candidate) => candidate.element === element);
	return tooltip?.props('text') as string | undefined;
}

/** The open tooltip's parts as read (`'Reply R'`), or null when focusing the control opens none. */
export async function focusTooltip(control: DOMWrapper<Element> | Element): Promise<string | null> {
	const element = (control instanceof Element ? control : control.element) as HTMLElement;
	element.focus();
	await nextTick();
	const bubble = document.querySelector('[role="tooltip"]');
	const text = bubble
		? Array.from(bubble.children)
				.map((part) => part.textContent?.trim() ?? '')
				.filter(Boolean)
				.join(' ')
		: null;
	element.blur();
	await nextTick();
	return text;
}
