/**
 * Placement for the Postbox composer's floating format bar (the Apple-minimal
 * mode). The bar appears above a non-empty text selection inside the editor,
 * flips below when there isn't room near the top, is clamped to the surface on
 * both horizontal edges, and hides on scroll/blur/collapse. It never steals
 * focus (the bar container uses `mousedown.prevent`).
 *
 * The math lives here (rather than inline in `PostboxBasicEditor.vue`) so the
 * flip/clamp/fail-soft behavior is unit-testable in isolation and the component
 * stays under the file-size ratchet.
 */
import type { Ref } from 'vue';

export interface FloatingFormatBarController {
	/** Placement style for the bar, or null when it should be hidden/unmounted. */
	formatBarStyle: Ref<Record<string, string> | null>;
	/** Bound to the bar component so its rendered size feeds the flip/clamp. */
	formatBarRef: Ref<{ $el?: HTMLElement } | null>;
	/** True when a non-empty text selection lives entirely inside the editor. */
	hasEditorSelection: () => boolean;
	/** Recompute placement for the current selection (or hide it). */
	refresh: () => void;
	/** Hide the bar immediately (blur/scroll). */
	hide: () => void;
}

export interface FloatingFormatBarOptions {
	editorRef: Ref<HTMLElement | null>;
	surfaceRef: Ref<HTMLElement | null>;
	/** True in floating mode; false when the classic persistent toolbar is on. */
	enabled: () => boolean;
}

export function usePostboxFloatingFormatBar(
	opts: FloatingFormatBarOptions,
): FloatingFormatBarController {
	const formatBarStyle = ref<Record<string, string> | null>(null);
	// Component ref — `$el` is the bar's root, measured for an accurate flip/clamp.
	const formatBarRef = ref<{ $el?: HTMLElement } | null>(null);

	function hasEditorSelection(): boolean {
		const el = opts.editorRef.value;
		const sel = window.getSelection();
		if (!el || !sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
		if (!el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) return false;
		return sel.toString().trim().length > 0;
	}

	function compute() {
		if (!opts.enabled() || !hasEditorSelection()) {
			formatBarStyle.value = null;
			return;
		}
		const surface = opts.surfaceRef.value;
		const sel = window.getSelection();
		if (!surface || !sel || sel.rangeCount === 0) {
			formatBarStyle.value = null;
			return;
		}
		const rect = sel.getRangeAt(0).getBoundingClientRect();
		if (!rect || (rect.top === 0 && rect.left === 0 && rect.width === 0)) {
			formatBarStyle.value = null; // fail-soft: hide rather than mis-place
			return;
		}
		const host = surface.getBoundingClientRect();
		const gap = 6;
		const bar = formatBarRef.value?.$el;
		const barHeight = bar?.offsetHeight ?? 40;
		const barWidth = bar?.offsetWidth ?? 0;
		// Clamp horizontally to both edges of the scrollable surface so a selection
		// near either margin doesn't push the bar off-screen.
		const rawLeft = rect.left - host.left + surface.scrollLeft;
		const maxLeft = Math.max(4, surface.scrollWidth - barWidth - 4);
		const left = Math.min(Math.max(4, rawLeft), maxLeft);
		// `topInView` = selection top relative to the visible surface, deciding the flip.
		const topInView = rect.top - host.top;
		if (topInView < barHeight + gap) {
			// Not enough room above → flip below the selection.
			formatBarStyle.value = {
				left: `${left}px`,
				top: `${rect.bottom - host.top + surface.scrollTop + gap}px`,
			};
		} else {
			formatBarStyle.value = {
				left: `${left}px`,
				top: `${rect.top - host.top + surface.scrollTop - gap}px`,
				transform: 'translateY(-100%)',
			};
		}
	}

	// A rendered bar can be measured for an accurate flip, so recompute once mounted.
	function refresh() {
		compute();
		if (formatBarStyle.value) void nextTick(() => compute());
	}

	function hide() {
		if (formatBarStyle.value) formatBarStyle.value = null;
	}

	function onScroll() {
		// Superhuman-style: the bar hides while the surface scrolls; it re-appears
		// on the next selection change.
		hide();
	}

	onMounted(() => {
		opts.surfaceRef.value?.addEventListener('scroll', onScroll, { passive: true });
	});
	onBeforeUnmount(() => {
		opts.surfaceRef.value?.removeEventListener('scroll', onScroll);
	});

	return { formatBarStyle, formatBarRef, hasEditorSelection, refresh, hide };
}
