import { describe, it, expect, vi } from 'vitest';
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
