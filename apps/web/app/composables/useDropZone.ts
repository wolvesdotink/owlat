import { getCurrentInstance, onMounted, onUnmounted, ref } from 'vue';
import type { Ref } from 'vue';

/**
 * Options for {@link useDropZone}.
 */
export interface UseDropZoneOptions {
	/**
	 * Optional gate. When it returns `false`, drag-over highlighting and drops
	 * are ignored (e.g. a viewer who lacks upload permission). Defaults to
	 * always-enabled.
	 */
	enabled?: () => boolean;
	/**
	 * On the desktop app (Tauri), also accept OS-level file drops (dragging a
	 * file from Finder/Explorer). Tauri intercepts native drags so the HTML5
	 * `@drop` handler never sees them; when enabled, this hooks the Tauri
	 * drag-drop event instead and forwards the dropped files to `onFiles`.
	 * No-op in the browser, where the HTML5 handlers remain the path.
	 * Must be called from component `setup()` (uses lifecycle hooks).
	 */
	osFileDrop?: boolean;
	/**
	 * Element used to scope OS-level drops: only drops (and drag-over
	 * highlighting) whose pointer is within this element's bounds are handled,
	 * so multiple mounted zones don't all react to one window drop. When
	 * omitted, OS drops anywhere on the window are accepted.
	 */
	rootRef?: Ref<HTMLElement | null>;
}

/**
 * The reactive state + handlers a drop zone needs. Bind them to the drop
 * target:
 *
 * ```vue
 * <div
 *   @dragover="handleDragOver"
 *   @dragleave="handleDragLeave"
 *   @drop="handleDrop"
 *   :class="isDragOver ? '…' : '…'"
 * >
 * ```
 */
export interface UseDropZoneReturn {
	/** `true` while a file is being dragged over the zone. */
	isDragOver: Ref<boolean>;
	/** `@dragover` handler — calls `preventDefault` and highlights the zone. */
	handleDragOver: (event: DragEvent) => void;
	/** `@dragleave` handler — clears the highlight. */
	handleDragLeave: () => void;
	/** `@drop` handler — calls `preventDefault`, clears the highlight and
	 *  forwards the dropped files (if any) to `onFiles`. */
	handleDrop: (event: DragEvent) => void;
}

/**
 * Shared HTML5 drag-and-drop file zone. Replaces the inline
 * `isDragOver`/`handleDragOver`/`handleDragLeave`/`handleDrop` trio that was
 * re-implemented in every upload surface (CSV import, blocklist import, file
 * upload, attachments, media picker, composer, media library). Each handler
 * preventDefaults the event so the browser doesn't navigate to the dropped
 * file, and `onFiles` receives the dropped `File[]` (empty drops are ignored).
 *
 * @param onFiles Callback invoked with the dropped files.
 * @param options Optional `enabled` gate (see {@link UseDropZoneOptions}).
 */
export function useDropZone(
	onFiles: (files: File[]) => void,
	options: UseDropZoneOptions = {}
): UseDropZoneReturn {
	const isDragOver = ref(false);
	const isEnabled = () => options.enabled?.() ?? true;

	const handleDragOver = (event: DragEvent) => {
		event.preventDefault();
		if (!isEnabled()) return;
		isDragOver.value = true;
	};

	const handleDragLeave = () => {
		isDragOver.value = false;
	};

	const handleDrop = (event: DragEvent) => {
		event.preventDefault();
		isDragOver.value = false;
		if (!isEnabled()) return;
		const files = event.dataTransfer?.files;
		if (files && files.length > 0) {
			onFiles(Array.from(files));
		}
	};

	if (options.osFileDrop) {
		registerOsFileDrop(isDragOver, isEnabled, onFiles, options.rootRef);
	}

	return {
		isDragOver,
		handleDragOver,
		handleDragLeave,
		handleDrop,
	};
}

/** `true` when running inside the Tauri desktop webview. */
function isTauri(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Wire the Tauri OS-level drag-drop event to a drop zone. Registered on mount
 * and torn down on unmount. When `rootRef` is set, only drops within that
 * element's bounds are handled (the Tauri event reports a physical-pixel
 * position, converted to CSS pixels here for the bounds test).
 */
function registerOsFileDrop(
	isDragOver: Ref<boolean>,
	isEnabled: () => boolean,
	onFiles: (files: File[]) => void,
	rootRef: Ref<HTMLElement | null> | undefined
): void {
	if (!isTauri() || !getCurrentInstance()) return;

	const isWithinRoot = (position: { x: number; y: number }): boolean => {
		const el = rootRef?.value;
		if (!el) return true;
		const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
		const x = position.x / dpr;
		const y = position.y / dpr;
		const rect = el.getBoundingClientRect();
		return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
	};

	let unlisten: (() => void) | undefined;
	let disposed = false;

	onMounted(async () => {
		const { onWebviewFileDrop } = await import('@owlat/desktop/src/dialog');
		const stop = await onWebviewFileDrop({
			onOver: (position) => {
				isDragOver.value = isEnabled() && isWithinRoot(position);
			},
			onLeave: () => {
				isDragOver.value = false;
			},
			onDrop: (files, position) => {
				isDragOver.value = false;
				if (!isEnabled()) return;
				if (!isWithinRoot(position)) return;
				if (files.length > 0) onFiles(files);
			},
		});
		// The component may have unmounted while the listener was registering.
		if (disposed) stop();
		else unlisten = stop;
	});

	onUnmounted(() => {
		disposed = true;
		unlisten?.();
	});
}
