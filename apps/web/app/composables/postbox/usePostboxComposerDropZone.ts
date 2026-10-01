import type { ComponentPublicInstance } from 'vue';

/** File drop and clipboard-paste wiring for the Postbox composer surface. */
export function usePostboxComposerDropZone(addFiles: (files: File[] | FileList) => Promise<void>) {
	const rootEl = ref<HTMLElement | null>(null);
	const {
		isDragOver: dragActive,
		handleDragOver: onDragOver,
		handleDragLeave: onDragLeave,
		handleDrop: onDrop,
	} = useDropZone(
		(files) => {
			void addFiles(files);
		},
		{ osFileDrop: true, rootRef: rootEl }
	);

	function onPaste(event: ClipboardEvent) {
		const files = Array.from(event.clipboardData?.files ?? []);
		if (files.length === 0) return;
		event.preventDefault();
		void addFiles(files);
	}

	/**
	 * A function ref for the composer's frame (`PostboxComposerShell`): its root
	 * element is the composer's root, where drops, keys and gap clicks land.
	 */
	function bindRoot(frame: Element | ComponentPublicInstance | null) {
		rootEl.value = frame && '$el' in frame ? (frame.$el as HTMLElement) : null;
	}

	return { rootEl, bindRoot, dragActive, onDragOver, onDragLeave, onDrop, onPaste };
}
