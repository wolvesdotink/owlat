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
 * Read one authorized path off disk (via the `read_authorized_file` Tauri
 * command) and wrap it in a `File` with the basename and an inferred MIME type,
 * so the existing upload/validation pipeline treats it exactly like an
 * `<input type=file>` selection. Rejects if the path isn't on the Rust-side
 * one-shot allowlist (i.e. wasn't just picked or dropped), is too large, or is
 * unreadable (e.g. a folder).
 */
async function readFileFromPath(path: string): Promise<File> {
	const buffer = await invoke<ArrayBuffer>('read_authorized_file', { path });
	const name = baseName(path);
	return new File([buffer], name, { type: mimeForName(name) });
}

/**
 * Read many paths into `File` objects, skipping any that fail (a dropped folder,
 * an unreadable or unauthorized path) rather than letting one bad entry poison
 * the whole batch or reject unhandled. Never rejects: callers always get the
 * readable files (possibly empty), so drop UIs can always clear their state.
 */
async function readFilesFromPaths(paths: string[]): Promise<File[]> {
	const results = await Promise.all(
		paths.map(async (path) => {
			try {
				return await readFileFromPath(path);
			} catch (error) {
				console.warn(`[dialog] Skipping unreadable file: ${path}`, error);
				return null;
			}
		})
	);
	return results.filter((file): file is File => file !== null);
}

/**
 * Open the native OS file picker and return the chosen files as `File`
 * objects. Returns an empty array when the user cancels. This is the desktop
 * replacement for `<input type=file>`: the picker runs entirely on the Rust
 * side (no path is ever passed from JS), and the same `File` objects flow into
 * the same validation and upload code.
 */
export async function pickFiles(options: PickFilesOptions = {}): Promise<File[]> {
	const paths = await invoke<string[]>('pick_files', {
		title: options.title,
		filters: options.filters ?? [],
		multiple: options.multiple ?? false,
	});
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
 * All active drop subscribers. A single module-level Tauri drag-drop listener
 * (registered lazily below) reads each drop's paths **once** and fans the
 * resulting `File[]` out to every subscriber, which hit-tests independently.
 *
 * Reading per-subscriber would be wrong: each read goes through
 * `read_authorized_file`, which consumes the Rust one-shot allowlist entry, so
 * with 2+ mounted zones (stacked popup composers, an inline reply + a popup, the
 * CSV modal open over a composer) only the first-registered listener's read of a
 * path would succeed and every other zone would get `[]` — its drop silently
 * no-ops. Single-read + fan-out also avoids shipping the file bytes over IPC
 * once per mounted zone.
 */
const dropSubscribers = new Set<WebviewFileDropHandlers>();

/** The shared drag-drop listener registration, created on the first subscriber. */
let dragDropListener: Promise<() => void> | null = null;

/** Run `visit` for each current subscriber over a snapshot (so a subscriber
 *  unsubscribing mid-drop can't disturb the iteration). */
function fanOutToSubscribers(visit: (handlers: WebviewFileDropHandlers) => void): void {
	for (const handlers of Array.from(dropSubscribers)) visit(handlers);
}

/** Register the single shared Tauri drag-drop listener once. */
function ensureDragDropListener(): Promise<() => void> {
	if (!dragDropListener) {
		dragDropListener = getCurrentWebview().onDragDropEvent((event) => {
			const payload = event.payload;
			if (payload.type === 'enter' || payload.type === 'over') {
				fanOutToSubscribers((h) => h.onOver?.(payload.position));
			} else if (payload.type === 'leave') {
				fanOutToSubscribers((h) => h.onLeave?.());
			} else if (payload.type === 'drop') {
				const position = payload.position;
				// Read each dropped path ONCE, then hand the same `File[]` to every
				// subscriber. `readFilesFromPaths` never rejects (it skips unreadable
				// entries), so `onDrop` always fires and every zone can clear its drag
				// state — even on a folder drop. The `.catch` is belt-and-suspenders.
				void readFilesFromPaths(payload.paths)
					.then((files) => fanOutToSubscribers((h) => h.onDrop(files, position)))
					.catch(() => fanOutToSubscribers((h) => h.onDrop([], position)));
			}
		});
	}
	return dragDropListener;
}

/**
 * Subscribe to OS-level file drops onto the app window. Tauri intercepts native
 * drags (the webview's HTML5 `drop` never sees them), so desktop drop support
 * must go through this event. All subscribers share one underlying listener that
 * reads each drop once and fans the files out (see {@link dropSubscribers}).
 * Resolves to an unsubscribe function.
 */
export async function onWebviewFileDrop(handlers: WebviewFileDropHandlers): Promise<() => void> {
	dropSubscribers.add(handlers);
	await ensureDragDropListener();
	return () => {
		dropSubscribers.delete(handlers);
	};
}
