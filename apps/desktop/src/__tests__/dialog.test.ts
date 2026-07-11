import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock every Tauri module dialog.ts pulls in. The picker and every file read
// now go through the Rust side: `invoke('pick_files')` opens the native dialog
// and returns the chosen absolute paths (recorded server-side as authorized
// reads), and `invoke('read_authorized_file', { path })` returns the bytes for
// one of those paths. `onDragDropEvent` is the OS-level drop stream. Hoisted so
// the spies exist when the mock factories run.
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

import { pickFiles } from '../dialog';

// The drag-drop listener is module-level shared state (one Tauri listener fans
// each drop out to every subscriber), so import a *fresh* dialog module per drop
// test to reset the subscriber set and the lazy listener registration.
async function freshDialog() {
	vi.resetModules();
	return import('../dialog');
}

/** Route `invoke` by command: `pick_files` returns paths, `read_authorized_file`
 *  returns each path's bytes (with an optional per-path override for failures). */
function stubInvoke(pickedPaths: string[], reads: Record<string, ArrayBuffer | Error> = {}) {
	invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
		if (cmd === 'pick_files') return Promise.resolve(pickedPaths);
		if (cmd === 'read_authorized_file') {
			const path = args?.path ?? '';
			const result = reads[path] ?? new Uint8Array([1, 2, 3]).buffer;
			return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
		}
		return Promise.reject(new Error(`unexpected invoke ${cmd}`));
	});
}

beforeEach(() => {
	openMock.mockReset();
	invokeMock.mockReset();
	onDragDropEventMock.mockReset();
});

describe('pickFiles', () => {
	it('returns [] when the user cancels the dialog', async () => {
		stubInvoke([]);

		const files = await pickFiles({ title: 'Choose a file' });

		expect(files).toEqual([]);
		expect(invokeMock).toHaveBeenCalledWith('pick_files', {
			title: 'Choose a file',
			filters: [],
			multiple: false,
		});
		// No paths → nothing read.
		expect(invokeMock).not.toHaveBeenCalledWith('read_authorized_file', expect.anything());
	});

	it('forwards filters/multiple and reads the picked path into a typed File', async () => {
		stubInvoke(['/Users/me/Documents/contacts.csv'], {
			'/Users/me/Documents/contacts.csv': new TextEncoder().encode('id,email').buffer,
		});

		const files = await pickFiles({
			title: 'Choose a CSV file',
			filters: [{ name: 'CSV', extensions: ['csv'] }],
		});

		expect(invokeMock).toHaveBeenCalledWith('pick_files', {
			title: 'Choose a CSV file',
			filters: [{ name: 'CSV', extensions: ['csv'] }],
			multiple: false,
		});
		expect(invokeMock).toHaveBeenCalledWith('read_authorized_file', {
			path: '/Users/me/Documents/contacts.csv',
		});
		expect(files).toHaveLength(1);
		// Basename + inferred MIME so downstream `.csv`/type validation is intact.
		expect(files[0]?.name).toBe('contacts.csv');
		expect(files[0]?.type).toBe('text/csv');
	});

	it('reads every path when multiple files are chosen', async () => {
		stubInvoke(['/a/one.png', '/b/two.pdf']);

		const files = await pickFiles({ multiple: true });

		expect(files.map((f) => f.name)).toEqual(['one.png', 'two.pdf']);
		expect(files.map((f) => f.type)).toEqual(['image/png', 'application/pdf']);
	});

	it('skips a file that fails to read instead of poisoning the whole batch', async () => {
		stubInvoke(['/a/good.png', '/b/broken.pdf'], {
			'/b/broken.pdf': new Error('read failed'),
		});

		const files = await pickFiles({ multiple: true });

		expect(files.map((f) => f.name)).toEqual(['good.png']);
	});
});

describe('onWebviewFileDrop', () => {
	/** Capture the shared drag-drop handler the module registers. */
	function captureHandler(unlisten = vi.fn()) {
		const ref: { handler?: (event: { payload: unknown }) => void } = {};
		onDragDropEventMock.mockImplementation((cb: (event: { payload: unknown }) => void) => {
			ref.handler = cb;
			return Promise.resolve(unlisten);
		});
		return ref;
	}

	it('reads dropped paths into Files and forwards them on the drop event', async () => {
		const { onWebviewFileDrop } = await freshDialog();
		const ref = captureHandler();
		stubInvoke([], { '/x/report.pdf': new Uint8Array([1]).buffer });

		const onDrop = vi.fn();
		const onOver = vi.fn();
		await onWebviewFileDrop({ onDrop, onOver });

		// Drag-over highlights via position; no file read yet.
		ref.handler?.({ payload: { type: 'over', position: { x: 10, y: 20 } } });
		expect(onOver).toHaveBeenCalledWith({ x: 10, y: 20 });

		// Drop reads the paths, then reports Files.
		ref.handler?.({
			payload: { type: 'drop', paths: ['/x/report.pdf'], position: { x: 1, y: 2 } },
		});
		await vi.waitFor(() => expect(onDrop).toHaveBeenCalledTimes(1));
		const droppedFiles = onDrop.mock.calls[0]?.[0] as File[];
		expect(droppedFiles[0]?.name).toBe('report.pdf');
	});

	it('reads each path once and fans the same Files out to every subscriber', async () => {
		const { onWebviewFileDrop } = await freshDialog();
		const ref = captureHandler();
		stubInvoke([], { '/x/report.pdf': new Uint8Array([1]).buffer });

		const onDropA = vi.fn();
		const onDropB = vi.fn();
		await onWebviewFileDrop({ onDrop: onDropA });
		await onWebviewFileDrop({ onDrop: onDropB });

		// Two zones, but a single shared listener (not one per subscriber).
		expect(onDragDropEventMock).toHaveBeenCalledTimes(1);

		ref.handler?.({
			payload: { type: 'drop', paths: ['/x/report.pdf'], position: { x: 1, y: 2 } },
		});
		await vi.waitFor(() => {
			expect(onDropA).toHaveBeenCalledTimes(1);
			expect(onDropB).toHaveBeenCalledTimes(1);
		});

		// Both subscribers receive the *same* File[] instance (single read → fan-out),
		// so a second-registered zone under the pointer still gets the dropped files
		// instead of `[]` from a consumed one-shot allowlist entry.
		const filesA = onDropA.mock.calls[0]?.[0] as File[];
		const filesB = onDropB.mock.calls[0]?.[0] as File[];
		expect(filesA[0]?.name).toBe('report.pdf');
		expect(filesB).toBe(filesA);

		// The path was read exactly once — not once per mounted zone.
		const reads = invokeMock.mock.calls.filter(([cmd]) => cmd === 'read_authorized_file');
		expect(reads).toHaveLength(1);
	});

	it('stops delivering drops to a subscriber after it unsubscribes', async () => {
		const { onWebviewFileDrop } = await freshDialog();
		const ref = captureHandler();
		stubInvoke([], { '/x/report.pdf': new Uint8Array([1]).buffer });

		const onDropA = vi.fn();
		const onDropB = vi.fn();
		const stopA = await onWebviewFileDrop({ onDrop: onDropA });
		await onWebviewFileDrop({ onDrop: onDropB });

		stopA();
		ref.handler?.({
			payload: { type: 'drop', paths: ['/x/report.pdf'], position: { x: 1, y: 2 } },
		});
		await vi.waitFor(() => expect(onDropB).toHaveBeenCalledTimes(1));
		expect(onDropA).not.toHaveBeenCalled();
	});

	it('still fires onDrop (clearing drag state) when a dropped path is unreadable', async () => {
		const { onWebviewFileDrop } = await freshDialog();
		const ref = captureHandler();
		// A folder drop: the read rejects. onDrop must still fire (with the empty
		// result) so the drop zone can clear its stuck drag highlight.
		stubInvoke([], { '/some/folder': new Error('is a directory') });

		const onDrop = vi.fn();
		await onWebviewFileDrop({ onDrop });

		ref.handler?.({
			payload: { type: 'drop', paths: ['/some/folder'], position: { x: 1, y: 2 } },
		});
		await vi.waitFor(() => expect(onDrop).toHaveBeenCalledTimes(1));
		expect(onDrop.mock.calls[0]?.[0]).toEqual([]);
	});
});
