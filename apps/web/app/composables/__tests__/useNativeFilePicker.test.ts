import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';

// The native picker routes "click to browse" through the OS dialog on desktop
// and returns `File` objects — the same shape `<input type=file>` produces, so
// the existing type validation/upload path is untouched. On web there is no
// native picker; callers keep their `<input type=file>` fallback, so
// `pickNativeFiles` must resolve to an empty array WITHOUT importing the
// desktop bridge.

const pickFiles =
	vi.fn<(options?: { title?: string; multiple?: boolean; filters?: unknown }) => Promise<File[]>>();
vi.mock('@owlat/desktop/src/dialog', () => ({
	pickFiles: (options?: unknown) => pickFiles(options as never),
}));

const isDesktop = ref(false);
vi.mock('~/composables/useDesktopContext', () => ({
	useDesktopContext: () => ({ isDesktop }),
}));

import { useNativeFilePicker } from '../useNativeFilePicker';

describe('useNativeFilePicker', () => {
	beforeEach(() => {
		pickFiles.mockReset();
		isDesktop.value = false;
	});

	it('does not open the native dialog in the browser (web keeps its <input>)', async () => {
		isDesktop.value = false;
		const { pickNativeFiles } = useNativeFilePicker();

		const files = await pickNativeFiles({ title: 'Choose a file' });

		expect(files).toEqual([]);
		expect(pickFiles).not.toHaveBeenCalled();
	});

	it('opens the native OS dialog on desktop and returns the chosen files', async () => {
		isDesktop.value = true;
		const chosen = new File(['id,email\n1,a@b.co'], 'contacts.csv', { type: 'text/csv' });
		pickFiles.mockResolvedValue([chosen]);
		const { pickNativeFiles } = useNativeFilePicker();

		const files = await pickNativeFiles({
			title: 'Choose a CSV file',
			filters: [{ name: 'CSV', extensions: ['csv'] }],
		});

		expect(pickFiles).toHaveBeenCalledWith({
			title: 'Choose a CSV file',
			filters: [{ name: 'CSV', extensions: ['csv'] }],
		});
		expect(files).toHaveLength(1);
		// The returned value is a real File, so downstream .name/.type validation
		// (e.g. the `.csv` check, the MIME/size guard) runs exactly as on web.
		expect(files[0]).toBeInstanceOf(File);
		expect(files[0]?.name).toBe('contacts.csv');
		expect(files[0]?.type).toBe('text/csv');
	});
});
