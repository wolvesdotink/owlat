import { ref } from 'vue';

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
	options: UseDropZoneOptions = {},
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

	return {
		isDragOver,
		handleDragOver,
		handleDragLeave,
		handleDrop,
	};
}
