import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock every Tauri module dialog.ts pulls in. `open` is the native picker,
// `invoke('read_file')` reads a chosen path's bytes, and onDragDropEvent is the
// OS-level drop stream. Hoisted so the spies exist when the mock factories run.
const { openMock, invokeMock, onDragDropEventMock } = vi.hoisted(() => ({
	openMock: vi.fn(),
	invokeMock: vi.fn(),
	onDragDropEventMock: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
	open: (...args: unknown[]) => openMock(...args),
}));
vi.mock('@tauri-apps/api/core', () => ({
	invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock('@tauri-apps/api/path', () => ({
	homeDir: vi.fn(async () => '/home/user'),
	join: vi.fn(async (...parts: string[]) => parts.join('/')),
}));
vi.mock('@tauri-apps/api/webview', () => ({
	getCurrentWebview: () => ({ onDragDropEvent: onDragDropEventMock }),
}));

import { pickFiles, onWebviewFileDrop } from '../dialog';

beforeEach(() => {
	openMock.mockReset();
	invokeMock.mockReset();
	onDragDropEventMock.mockReset();
});

describe('pickFiles', () => {
	it('returns [] when the user cancels the dialog', async () => {
		openMock.mockResolvedValue(null);

		const files = await pickFiles({ title: 'Choose a file' });

		expect(files).toEqual([]);
		expect(invokeMock).not.toHaveBeenCalled();
	});

	it('forwards filters/multiple and reads the picked path into a typed File', async () => {
		openMock.mockResolvedValue('/Users/me/Documents/contacts.csv');
		invokeMock.mockResolvedValue(new TextEncoder().encode('id,email').buffer);

		const files = await pickFiles({
			title: 'Choose a CSV file',
			filters: [{ name: 'CSV', extensions: ['csv'] }],
		});

		expect(openMock).toHaveBeenCalledWith({
			title: 'Choose a CSV file',
			multiple: false,
			directory: false,
			filters: [{ name: 'CSV', extensions: ['csv'] }],
		});
		expect(invokeMock).toHaveBeenCalledWith('read_file', {
			path: '/Users/me/Documents/contacts.csv',
		});
		expect(files).toHaveLength(1);
		// Basename + inferred MIME so downstream `.csv`/type validation is intact.
		expect(files[0]?.name).toBe('contacts.csv');
		expect(files[0]?.type).toBe('text/csv');
	});

	it('reads every path when multiple files are chosen', async () => {
		openMock.mockResolvedValue(['/a/one.png', '/b/two.pdf']);
		invokeMock.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);

		const files = await pickFiles({ multiple: true });

		expect(files.map((f) => f.name)).toEqual(['one.png', 'two.pdf']);
		expect(files.map((f) => f.type)).toEqual(['image/png', 'application/pdf']);
	});
});

describe('onWebviewFileDrop', () => {
	it('reads dropped paths into Files and forwards them on the drop event', async () => {
		const unlisten = vi.fn();
		let handler: ((event: { payload: unknown }) => void) | undefined;
		onDragDropEventMock.mockImplementation((cb: (event: { payload: unknown }) => void) => {
			handler = cb;
			return Promise.resolve(unlisten);
		});
		invokeMock.mockResolvedValue(new Uint8Array([1]).buffer);

		const onDrop = vi.fn();
		const onOver = vi.fn();
		const stop = await onWebviewFileDrop({ onDrop, onOver });

		// Drag-over highlights via position; no file read yet.
		handler?.({ payload: { type: 'over', position: { x: 10, y: 20 } } });
		expect(onOver).toHaveBeenCalledWith({ x: 10, y: 20 });

		// Drop reads the paths, then reports Files.
		handler?.({
			payload: { type: 'drop', paths: ['/x/report.pdf'], position: { x: 1, y: 2 } },
		});
		await vi.waitFor(() => expect(onDrop).toHaveBeenCalledTimes(1));
		const droppedFiles = onDrop.mock.calls[0]?.[0] as File[];
		expect(droppedFiles[0]?.name).toBe('report.pdf');
		expect(stop).toBe(unlisten);
	});
});
