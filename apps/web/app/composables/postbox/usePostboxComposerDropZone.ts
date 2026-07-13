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

	return { rootEl, dragActive, onDragOver, onDragLeave, onDrop, onPaste };
}
