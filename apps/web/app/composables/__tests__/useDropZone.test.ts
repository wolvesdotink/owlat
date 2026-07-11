import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineComponent, h, ref, type Ref } from 'vue';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';

// The OS drop bridge and the desktop check are the two seams useDropZone pulls
// in for `osFileDrop`. Mock both: `onWebviewFileDrop` captures the handlers so
// the test can drive drag-over/drop with synthetic positions; `useDesktopContext`
// forces the desktop branch on. (The plain HTML5-handler tests below don't set
// `osFileDrop`, so they never touch either mock.)
const onWebviewFileDrop = vi.fn();
vi.mock('@owlat/desktop/src/dialog', () => ({
	onWebviewFileDrop: (handlers: unknown) => onWebviewFileDrop(handlers),
}));

const isDesktop = ref(true);
vi.mock('~/composables/useDesktopContext', () => ({
	useDesktopContext: () => ({ isDesktop }),
}));

import { useDropZone } from '../useDropZone';

/** Build a minimal DragEvent stand-in with a tracked preventDefault + files. */
function dragEvent(files: File[] = []): DragEvent & { preventDefault: ReturnType<typeof vi.fn> } {
	const fileList = {
		length: files.length,
		item: (i: number) => files[i] ?? null,
		...files,
	} as unknown as FileList;
	return {
		preventDefault: vi.fn(),
		dataTransfer: { files: fileList },
	} as unknown as DragEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

describe('useDropZone', () => {
	it('starts with isDragOver=false', () => {
		const { isDragOver } = useDropZone(() => {});
		expect(isDragOver.value).toBe(false);
	});

	it('handleDragOver preventDefaults and highlights the zone', () => {
		const { isDragOver, handleDragOver } = useDropZone(() => {});
		const ev = dragEvent();
		handleDragOver(ev);
		expect(ev.preventDefault).toHaveBeenCalledOnce();
		expect(isDragOver.value).toBe(true);
	});

	it('handleDragLeave clears the highlight', () => {
		const { isDragOver, handleDragOver, handleDragLeave } = useDropZone(() => {});
		handleDragOver(dragEvent());
		expect(isDragOver.value).toBe(true);
		handleDragLeave();
		expect(isDragOver.value).toBe(false);
	});

	it('handleDrop preventDefaults, clears highlight, and forwards dropped files', () => {
		const onFiles = vi.fn();
		const { isDragOver, handleDragOver, handleDrop } = useDropZone(onFiles);
		handleDragOver(dragEvent());

		const a = new File(['a'], 'a.csv');
		const b = new File(['b'], 'b.txt');
		const ev = dragEvent([a, b]);
		handleDrop(ev);

		expect(ev.preventDefault).toHaveBeenCalledOnce();
		expect(isDragOver.value).toBe(false);
		expect(onFiles).toHaveBeenCalledOnce();
		expect(onFiles).toHaveBeenCalledWith([a, b]);
	});

	it('handleDrop with no files does not call onFiles', () => {
		const onFiles = vi.fn();
		const { handleDrop } = useDropZone(onFiles);
		handleDrop(dragEvent([]));
		expect(onFiles).not.toHaveBeenCalled();
	});

	it('handleDrop tolerates a missing dataTransfer', () => {
		const onFiles = vi.fn();
		const { handleDrop } = useDropZone(onFiles);
		const ev = { preventDefault: vi.fn(), dataTransfer: null } as unknown as DragEvent;
		expect(() => handleDrop(ev)).not.toThrow();
		expect(onFiles).not.toHaveBeenCalled();
	});

	describe('enabled gate', () => {
		it('ignores dragover highlight when disabled', () => {
			const { isDragOver, handleDragOver } = useDropZone(() => {}, { enabled: () => false });
			const ev = dragEvent();
			handleDragOver(ev);
			// preventDefault still fires so the browser does not navigate
			expect(ev.preventDefault).toHaveBeenCalledOnce();
			expect(isDragOver.value).toBe(false);
		});

		it('ignores drops when disabled', () => {
			const onFiles = vi.fn();
			const { handleDrop } = useDropZone(onFiles, { enabled: () => false });
			handleDrop(dragEvent([new File(['a'], 'a.csv')]));
			expect(onFiles).not.toHaveBeenCalled();
		});

		it('honors a dynamic enabled gate', () => {
			let allowed = false;
			const onFiles = vi.fn();
			const { handleDrop } = useDropZone(onFiles, { enabled: () => allowed });
			handleDrop(dragEvent([new File(['a'], 'a.csv')]));
			expect(onFiles).not.toHaveBeenCalled();
			allowed = true;
			handleDrop(dragEvent([new File(['b'], 'b.csv')]));
			expect(onFiles).toHaveBeenCalledOnce();
		});
	});
});

interface OsDropHandlers {
	onOver?: (position: { x: number; y: number }) => void;
	onLeave?: () => void;
	onDrop: (files: File[], position: { x: number; y: number }) => void;
}

let wrapper: VueWrapper | null = null;

/**
 * Mount a host that wires `useDropZone` with `osFileDrop`, optionally scoping to
 * a root element (rendered behind `show` so a test can leave it unmounted). The
 * root is stubbed to occupy the CSS rectangle (0,0)-(100,100). Returns the
 * captured OS-drop handlers plus the reactive state to assert on.
 */
async function mountHost(opts: { withRoot: boolean; show?: boolean }) {
	const onFiles = vi.fn();
	let isDragOver!: Ref<boolean>;
	let rootRef!: Ref<HTMLElement | null>;
	const show = ref(opts.show ?? true);

	const Host = defineComponent({
		setup() {
			rootRef = ref<HTMLElement | null>(null);
			const zone = useDropZone(
				onFiles,
				opts.withRoot ? { osFileDrop: true, rootRef } : { osFileDrop: true }
			);
			isDragOver = zone.isDragOver;
			return () => h('div', [show.value ? h('div', { ref: rootRef, class: 'root' }) : null]);
		},
	});

	wrapper = mount(Host, { attachTo: document.body });
	await flushPromises();

	if (rootRef.value) {
		rootRef.value.getBoundingClientRect = () =>
			({
				left: 0,
				top: 0,
				right: 100,
				bottom: 100,
				width: 100,
				height: 100,
				x: 0,
				y: 0,
			}) as DOMRect;
	}

	const handlers = onWebviewFileDrop.mock.calls[0]?.[0] as OsDropHandlers | undefined;
	return {
		handlers,
		onFiles,
		get isDragOver() {
			return isDragOver;
		},
	};
}

const droppedFile = () => new File(['x'], 'dropped.txt', { type: 'text/plain' });

describe('useDropZone osFileDrop hit-testing', () => {
	beforeEach(() => {
		onWebviewFileDrop.mockReset();
		onWebviewFileDrop.mockResolvedValue(vi.fn());
		isDesktop.value = true;
	});

	afterEach(() => {
		try {
			wrapper?.unmount();
		} catch {
			// already unmounted
		}
		wrapper = null;
	});

	it('accepts a drop whose pointer is inside the scoped root', async () => {
		const host = await mountHost({ withRoot: true });

		host.handlers?.onOver?.({ x: 50, y: 50 });
		expect(host.isDragOver.value).toBe(true);

		host.handlers?.onDrop([droppedFile()], { x: 50, y: 50 });
		expect(host.onFiles).toHaveBeenCalledTimes(1);
		expect(host.isDragOver.value).toBe(false);
	});

	it('ignores a drop whose pointer is outside the scoped root', async () => {
		const host = await mountHost({ withRoot: true });

		host.handlers?.onOver?.({ x: 250, y: 250 });
		expect(host.isDragOver.value).toBe(false);

		host.handlers?.onDrop([droppedFile()], { x: 250, y: 250 });
		expect(host.onFiles).not.toHaveBeenCalled();
	});

	it('rejects any drop when the scoped root is unmounted (v-if off)', async () => {
		// rootRef was provided but its element never mounts — the CSV import case
		// where the drop zone only exists on the upload step. A stray window drop
		// on the mapping step (or while the modal is closed) must NOT re-ingest.
		const host = await mountHost({ withRoot: true, show: false });

		host.handlers?.onOver?.({ x: 50, y: 50 });
		expect(host.isDragOver.value).toBe(false);

		host.handlers?.onDrop([droppedFile()], { x: 50, y: 50 });
		expect(host.onFiles).not.toHaveBeenCalled();
	});

	it('accepts a drop anywhere when no root is provided', async () => {
		const host = await mountHost({ withRoot: false });

		host.handlers?.onDrop([droppedFile()], { x: 999, y: 999 });
		expect(host.onFiles).toHaveBeenCalledTimes(1);
	});
});
