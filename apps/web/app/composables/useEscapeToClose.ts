import type { Ref } from 'vue';
import { useEscapeLayer } from '@owlat/ui/composables/useEscapeLayer';
import { isImeComposing } from '~/utils/imeComposition';

/**
 * Esc closes an open popover, and that press ends there.
 *
 * A popover that closes on Esc without claiming the key lets the same press
 * reach the page's own Esc: the Postbox reader closes the conversation
 * (`postbox.close`) and Answer mode leaves for the list, so the person who only
 * meant to dismiss a panel lands somewhere else. While open, the popover is
 * one layer of the shared Escape stack (`useEscapeLayer`, a window capture
 * listener), so it runs before the shortcut dispatcher and the pages' own
 * handlers, works while focus is still on the trigger, and sits above Zen mode
 * and anything that opened before it: the press closes the innermost thing on
 * screen and nothing else.
 */
export function useEscapeToClose(open: Ref<boolean>): void {
	useEscapeLayer(open, (event) => {
		if (isImeComposing(event)) return false;
		open.value = false;
	});
}
