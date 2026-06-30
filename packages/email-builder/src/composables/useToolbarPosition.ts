import { ref, watch, onMounted, onUnmounted, type Ref, type ShallowRef } from 'vue';

export interface UseToolbarPositionOptions {
	anchorElement: Ref<HTMLElement | null> | ShallowRef<HTMLElement | null>;
	toolbarElement: Ref<HTMLElement | null> | ShallowRef<HTMLElement | null>;
}

export interface UseToolbarPositionReturn {
	positionStyles: Ref<{ top: string; left: string }>;
}

/**
 * Positions a floating toolbar relative to an anchor element.
 * Places above by default, flips below if no space, clamps to viewport.
 */
export function useToolbarPosition(options: UseToolbarPositionOptions): UseToolbarPositionReturn {
	const { anchorElement, toolbarElement } = options;

	const positionStyles = ref({ top: '-9999px', left: '-9999px' });
	let rafId: number | null = null;

	function updatePosition() {
		const anchor = anchorElement.value;
		const toolbar = toolbarElement.value;
		if (!anchor || !toolbar) {
			positionStyles.value = { top: '-9999px', left: '-9999px' };
			return;
		}

		const anchorRect = anchor.getBoundingClientRect();
		const toolbarRect = toolbar.getBoundingClientRect();
		const gap = 8;

		// Center horizontally on anchor
		let left = anchorRect.left + (anchorRect.width - toolbarRect.width) / 2;

		// Position above anchor by default
		let top = anchorRect.top - toolbarRect.height - gap;

		// Flip below if no space above
		if (top < 8) {
			top = anchorRect.bottom + gap;
		}

		// Clamp horizontally to viewport
		left = Math.max(8, Math.min(left, window.innerWidth - toolbarRect.width - 8));

		// Clamp vertically to viewport
		top = Math.max(8, Math.min(top, window.innerHeight - toolbarRect.height - 8));

		positionStyles.value = {
			top: `${Math.round(top)}px`,
			left: `${Math.round(left)}px`,
		};
	}

	function scheduleUpdate() {
		if (rafId !== null) return;
		rafId = requestAnimationFrame(() => {
			rafId = null;
			updatePosition();
		});
	}

	// Watch anchor/toolbar changes
	watch([anchorElement, toolbarElement], () => {
		scheduleUpdate();
	});

	// Listen to scroll (capture) and resize
	onMounted(() => {
		window.addEventListener('scroll', scheduleUpdate, true);
		window.addEventListener('resize', scheduleUpdate);
		scheduleUpdate();
	});

	onUnmounted(() => {
		window.removeEventListener('scroll', scheduleUpdate, true);
		window.removeEventListener('resize', scheduleUpdate);
		if (rafId !== null) {
			cancelAnimationFrame(rafId);
		}
	});

	return { positionStyles };
}
