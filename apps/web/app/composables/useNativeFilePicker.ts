import type { PickFilesOptions } from '@owlat/desktop/src/dialog';
import { useDesktopContext } from '~/composables/useDesktopContext';

/**
 * Desktop-native file selection for the upload surfaces.
 *
 * On the desktop app (Tauri) this routes "click to browse" through the real OS
 * file picker and returns the chosen files as `File` objects — the same shape
 * an `<input type=file>` produces, so the existing type validation and upload
 * pipeline are untouched. In the browser there is no native picker; callers
 * keep their `<input type=file>` fallback and gate it on {@link isDesktop}.
 *
 * OS-level file *drops* (dragging from Finder/Explorer) are handled separately
 * by {@link useDropZone}'s `osFileDrop` option, which uses the same Tauri
 * bridge.
 */
export function useNativeFilePicker() {
	const { isDesktop } = useDesktopContext();

	/**
	 * Open the native OS file picker. Only valid on desktop (guard the call
	 * site with {@link isDesktop}); returns an empty array in the browser or
	 * when the user cancels.
	 */
	async function pickNativeFiles(options: PickFilesOptions = {}): Promise<File[]> {
		if (!isDesktop.value) return [];
		try {
			const { pickFiles } = await import('@owlat/desktop/src/dialog');
			return await pickFiles(options);
		} catch (error) {
			// A picker/read failure resolves to "no files" (like a cancel) so it
			// never leaks as an unhandled rejection into the `@click` handlers that
			// call this (FileUploadModal.browse, composer onAttachClick,
			// useCsvImport.triggerFileInput).
			console.warn('[useNativeFilePicker] Native file pick failed', error);
			return [];
		}
	}

	return { isDesktop, pickNativeFiles };
}
