// @vitest-environment happy-dom
/**
 * Placement math for the composer's floating format bar. These are the behaviors
 * the spec is about — appear above a non-empty in-editor selection, flip below
 * when there isn't room near the top, clamp to both horizontal edges of the
 * scrollable surface, and fail soft (hide) when the selection can't be measured.
 *
 * The composable runs in a component setup context (it registers a scroll
 * listener via onMounted), so we drive it through a tiny harness component and
 * mock the DOM Selection / rects it reads.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { defineComponent, onBeforeUnmount, nextTick, type Ref } from 'vue';
import { mount } from '@vue/test-utils';
import {
	usePostboxFloatingFormatBar,
	type FloatingFormatBarController,
} from '../usePostboxFloatingFormatBar';

beforeAll(() => {
	vi.stubGlobal('onBeforeUnmount', onBeforeUnmount);
});

afterEach(() => {
	vi.restoreAllMocks();
});

interface Rect {
	top: number;
	bottom: number;
	left: number;
	width: number;
}

/** Fake a non-collapsed Selection whose nodes live inside `node`, sizing to `rect`. */
function stubSelection(node: Node, rect: Rect, opts: { collapsed?: boolean; text?: string } = {}) {
	vi.spyOn(window, 'getSelection').mockReturnValue({
		rangeCount: 1,
		isCollapsed: opts.collapsed ?? false,
		anchorNode: node,
		focusNode: node,
		toString: () => opts.text ?? 'selected text',
		getRangeAt: () => ({ getBoundingClientRect: () => rect }) as unknown as Range,
	} as unknown as Selection);
}

/**
 * Mount the composable inside a harness. The surface is 300px wide, scrolled to
 * origin, and anchored at viewport (0,0) so surface-relative math == raw coords.
 */
function mountBar(enabled: () => boolean): {
	ctl: FloatingFormatBarController;
	editor: HTMLElement;
} {
	let captured!: FloatingFormatBarController;
	let editorEl!: HTMLElement;
	mount(
		defineComponent({
			setup() {
				const editorRef = ref<HTMLElement | null>(null) as Ref<HTMLElement | null>;
				const surfaceRef = ref<HTMLElement | null>(null) as Ref<HTMLElement | null>;
				const editor = document.createElement('div');
				const surface = document.createElement('div');
				surface.getBoundingClientRect = () =>
					({ top: 0, left: 0 }) as DOMRect;
				Object.defineProperty(surface, 'scrollLeft', { value: 0, configurable: true });
				Object.defineProperty(surface, 'scrollTop', { value: 0, configurable: true });
				Object.defineProperty(surface, 'scrollWidth', { value: 300, configurable: true });
				editorRef.value = editor;
				surfaceRef.value = surface;
				editorEl = editor;
				captured = usePostboxFloatingFormatBar({ editorRef, surfaceRef, enabled });
				return () => null;
			},
		}),
	);
	return { ctl: captured, editor: editorEl };
}

async function refresh(ctl: FloatingFormatBarController) {
	ctl.refresh();
	await nextTick();
}

describe('usePostboxFloatingFormatBar', () => {
	it('hides when the classic toolbar is active (disabled)', async () => {
		const { ctl, editor } = mountBar(() => false);
		stubSelection(editor, { top: 200, bottom: 220, left: 20, width: 40 });
		await refresh(ctl);
		expect(ctl.formatBarStyle.value).toBeNull();
	});

	it('hides on a collapsed selection', async () => {
		const { ctl, editor } = mountBar(() => true);
		stubSelection(editor, { top: 200, bottom: 220, left: 20, width: 40 }, { collapsed: true });
		await refresh(ctl);
		expect(ctl.formatBarStyle.value).toBeNull();
	});

	it('fails soft (hides) when the selection rect is unmeasurable', async () => {
		const { ctl, editor } = mountBar(() => true);
		stubSelection(editor, { top: 0, bottom: 0, left: 0, width: 0 });
		await refresh(ctl);
		expect(ctl.formatBarStyle.value).toBeNull();
	});

	it('places the bar above the selection when there is room', async () => {
		const { ctl, editor } = mountBar(() => true);
		stubSelection(editor, { top: 200, bottom: 220, left: 20, width: 40 });
		await refresh(ctl);
		const style = ctl.formatBarStyle.value;
		expect(style).not.toBeNull();
		// top = rect.top - gap(6); anchored above via translateY(-100%)
		expect(style?.top).toBe('194px');
		expect(style?.transform).toBe('translateY(-100%)');
		expect(style?.left).toBe('20px');
	});

	it('flips below the selection when near the top edge', async () => {
		const { ctl, editor } = mountBar(() => true);
		stubSelection(editor, { top: 10, bottom: 30, left: 20, width: 40 });
		await refresh(ctl);
		const style = ctl.formatBarStyle.value;
		// topInView(10) < barHeight(40)+gap(6) → below: top = rect.bottom + gap
		expect(style?.top).toBe('36px');
		expect(style?.transform).toBeUndefined();
	});

	it('clamps the left edge against the right of the surface', async () => {
		const { ctl, editor } = mountBar(() => true);
		// A selection far past the 300px-wide surface must not push the bar off-screen.
		stubSelection(editor, { top: 200, bottom: 220, left: 1000, width: 40 });
		await refresh(ctl);
		// maxLeft = scrollWidth(300) - barWidth(0) - 4 = 296
		expect(ctl.formatBarStyle.value?.left).toBe('296px');
	});

	it('hide() clears a shown bar', async () => {
		const { ctl, editor } = mountBar(() => true);
		stubSelection(editor, { top: 200, bottom: 220, left: 20, width: 40 });
		await refresh(ctl);
		expect(ctl.formatBarStyle.value).not.toBeNull();
		ctl.hide();
		expect(ctl.formatBarStyle.value).toBeNull();
	});
});
