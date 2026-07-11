/**
 * Native file-picker dialogs (tauri-plugin-dialog) and OS-level file drops.
 */
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';
import { homeDir, join } from '@tauri-apps/api/path';

/**
 * Open the system file picker to choose an SSH private key. Starts in
 * `~/.ssh` when it exists (the picker falls back to the last-used location
 * otherwise). Resolves to the absolute path, or null if the user cancelled.
 */
export async function pickSshKeyFile(): Promise<string | null> {
	let defaultPath: string | undefined;
	try {
		defaultPath = await join(await homeDir(), '.ssh');
	} catch {
		// Home directory resolution failed — let the picker use its default.
	}
	const picked = await open({
		title: 'Choose an SSH private key',
		multiple: false,
		directory: false,
		defaultPath,
	});
	return typeof picked === 'string' ? picked : null;
}

/** A dialog filter, mirroring tauri-plugin-dialog's `filters` entry. */
export interface FilePickerFilter {
	/** Human label shown in the picker's format dropdown (e.g. "CSV"). */
	name: string;
	/** Extensions without the dot, e.g. `['csv']` or `['png', 'jpg']`. */
	extensions: string[];
}

/** Options for {@link pickFiles}. */
export interface PickFilesOptions {
	/** Dialog title. */
	title?: string;
	/** Allow selecting more than one file. Defaults to `false`. */
	multiple?: boolean;
	/** Optional format filters. Omit to accept any file. */
	filters?: FilePickerFilter[];
}

/**
 * Minimal extension→MIME map so the constructed `File` carries a useful
 * `type` (browsers set this from the input; the native picker gives us only a
 * path). Unknown extensions fall back to the empty string — every upload
 * surface already treats an empty type as `application/octet-stream`.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
	csv: 'text/csv',
	txt: 'text/plain',
	pdf: 'application/pdf',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	json: 'application/json',
	zip: 'application/zip',
	doc: 'application/msword',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xls: 'application/vnd.ms-excel',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function baseName(path: string): string {
	const segments = path.split(/[/\\]/);
	return segments[segments.length - 1] ?? path;
}

function mimeForName(name: string): string {
	const dot = name.lastIndexOf('.');
	if (dot < 0) return '';
	const ext = name.slice(dot + 1).toLowerCase();
	return MIME_BY_EXTENSION[ext] ?? '';
}

/**
 * Read the file at `path` off disk (via the `read_file` Tauri command) and wrap
 * it in a `File` with the basename and an inferred MIME type, so the existing
 * upload/validation pipeline treats it exactly like an `<input type=file>`
 * selection.
 */
async function readFileFromPath(path: string): Promise<File> {
	const buffer = await invoke<ArrayBuffer>('read_file', { path });
	const name = baseName(path);
	return new File([buffer], name, { type: mimeForName(name) });
}

/** Read many paths into `File` objects, preserving order. */
async function readFilesFromPaths(paths: string[]): Promise<File[]> {
	return Promise.all(paths.map(readFileFromPath));
}

/**
 * Open the native OS file picker and return the chosen files as `File`
 * objects. Returns an empty array when the user cancels. This is the desktop
 * replacement for `<input type=file>`: the same `File` objects flow into the
 * same validation and upload code.
 */
export async function pickFiles(options: PickFilesOptions = {}): Promise<File[]> {
	const picked = await open({
		title: options.title,
		multiple: options.multiple ?? false,
		directory: false,
		filters: options.filters,
	});
	if (picked === null) return [];
	const paths = Array.isArray(picked) ? picked : [picked];
	return readFilesFromPaths(paths);
}

/** Handlers for {@link onWebviewFileDrop}. */
export interface WebviewFileDropHandlers {
	/** Fired while files are dragged over the window (enter + move). */
	onOver?: (position: { x: number; y: number }) => void;
	/** Fired when the drag leaves the window or is cancelled. */
	onLeave?: () => void;
	/** Fired on drop with the dropped files read into `File` objects. */
	onDrop: (files: File[], position: { x: number; y: number }) => void;
}

/**
 * Subscribe to OS-level file drops onto the app window. Tauri intercepts
 * native drags (the webview's HTML5 `drop` never sees them), so desktop drop
 * support must go through this event. Resolves to an unlisten function.
 */
export async function onWebviewFileDrop(handlers: WebviewFileDropHandlers): Promise<() => void> {
	const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
		const payload = event.payload;
		if (payload.type === 'enter' || payload.type === 'over') {
			handlers.onOver?.(payload.position);
		} else if (payload.type === 'leave') {
			handlers.onLeave?.();
		} else if (payload.type === 'drop') {
			const position = payload.position;
			void readFilesFromPaths(payload.paths).then((files) => {
				handlers.onDrop(files, position);
			});
		}
	});
	return unlisten;
}
