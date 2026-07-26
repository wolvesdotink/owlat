import {
	writeJsonObjectPropertiesPrefix,
	type JsonValueWriter,
	type TextChunkSink,
} from './incrementalJsonSerializer';

const MAX_DESTINATION_WRITE_BYTES = 64 * 1024;
const OPFS_EXPORT_PREFIX = '.owlat-account-export-';
const OPFS_STALE_EXPORT_AGE_MS = 24 * 60 * 60 * 1000;
const OPFS_STALE_SCAN_LIMIT = 64;
const OPFS_STALE_REMOVE_LIMIT = 16;
function firstNonWhitespaceIndex(value: string): number {
	return value.search(/\S/);
}

export function jsonObjectWithStreamedProperties(
	metadata: Record<string, unknown>,
	content: ReadableStream<Uint8Array>
): JsonValueWriter {
	return async (sink) => {
		const metadataHasProperties = await writeJsonObjectPropertiesPrefix(sink, metadata);
		const reader = content.getReader();
		const decoder = new TextDecoder('utf-8', { fatal: true });
		let opened = false;
		let finalCandidate = '';
		let hasContentProperties = false;

		const writeInnerContent = async (text: string) => {
			if (!text) return;
			if (!hasContentProperties) {
				const firstContentIndex = firstNonWhitespaceIndex(text);
				if (firstContentIndex === -1) return;
				if (metadataHasProperties) await sink.write(',');
				hasContentProperties = true;
				await sink.write(text.slice(firstContentIndex));
				return;
			}
			await sink.write(text);
		};
		const processText = async (text: string) => {
			let remaining = text;
			if (!opened) {
				const openingIndex = firstNonWhitespaceIndex(remaining);
				if (openingIndex === -1) return;
				if (remaining[openingIndex] !== '{') {
					throw new TypeError('Account export content is not a JSON object');
				}
				opened = true;
				remaining = remaining.slice(openingIndex + 1);
			}
			if (!remaining) return;
			if (finalCandidate) await writeInnerContent(finalCandidate);
			await writeInnerContent(remaining.slice(0, -1));
			finalCandidate = remaining.at(-1) ?? '';
		};

		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				await processText(decoder.decode(value, { stream: true }));
			}
			await processText(decoder.decode());
			if (!opened || finalCandidate !== '}') {
				throw new TypeError('Account export content is not a complete JSON object');
			}
			await sink.write('}');
		} catch (error) {
			try {
				await reader.cancel(error);
			} catch {
				// Preserve the parsing or destination error if cancelling the response also fails.
			}
			throw error;
		} finally {
			reader.releaseLock();
		}
	};
}

interface SaveFilePickerWindow extends Window {
	showSaveFilePicker?: (options: {
		suggestedName: string;
		types: Array<{
			description: string;
			accept: Record<string, string[]>;
		}>;
	}) => Promise<FileSystemFileHandle>;
}

export function isSaveFilePickerCancellation(error: unknown): boolean {
	return error instanceof SaveFilePickerCancellation;
}

class SaveFilePickerCancellation extends Error {
	constructor() {
		super('Account export destination selection was cancelled');
		this.name = 'SaveFilePickerCancellation';
	}
}

function isAbortError(error: unknown): boolean {
	return (
		error !== null && typeof error === 'object' && 'name' in error && error.name === 'AbortError'
	);
}

export function revokeObjectUrlAfterDownloadNavigation(url: string): void {
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadFile(file: File, filename: string): void {
	const url = URL.createObjectURL(file);
	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
	revokeObjectUrlAfterDownloadNavigation(url);
}

async function openPickerSink(filename: string): Promise<TextChunkSink | null> {
	const pickerWindow = window as SaveFilePickerWindow;
	if (!pickerWindow.showSaveFilePicker) return null;
	let handle: FileSystemFileHandle;
	try {
		handle = await pickerWindow.showSaveFilePicker({
			suggestedName: filename,
			types: [
				{
					description: 'JSON data',
					accept: { 'application/json': ['.json'] },
				},
			],
		});
	} catch (error) {
		if (isAbortError(error)) throw new SaveFilePickerCancellation();
		throw error;
	}
	const writable = await handle.createWritable();
	return {
		write: (chunk) => writable.write(chunk),
		close: () => writable.close(),
		abort: (reason) => writable.abort(reason),
	};
}

type IterableFileSystemDirectoryHandle = FileSystemDirectoryHandle & {
	entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
};

async function removeStaleOriginPrivateFileSystemExports(
	directory: FileSystemDirectoryHandle
): Promise<void> {
	const entries = (directory as IterableFileSystemDirectoryHandle).entries;
	if (typeof entries !== 'function') return;

	let scanned = 0;
	let removalAttempts = 0;
	try {
		for await (const [name, entry] of entries.call(directory)) {
			scanned += 1;
			if (
				name.startsWith(OPFS_EXPORT_PREFIX) &&
				entry.kind === 'file' &&
				removalAttempts < OPFS_STALE_REMOVE_LIMIT
			) {
				try {
					const file = await (entry as FileSystemFileHandle).getFile();
					if (Date.now() - file.lastModified >= OPFS_STALE_EXPORT_AGE_MS) {
						removalAttempts += 1;
						await directory.removeEntry(name);
					}
				} catch {
					// One unreadable or concurrently removed entry must not block a new export.
				}
			}
			if (scanned >= OPFS_STALE_SCAN_LIMIT || removalAttempts >= OPFS_STALE_REMOVE_LIMIT) {
				break;
			}
		}
	} catch {
		// Enumeration is best-effort; opening the requested export remains the priority.
	}
}

async function openOriginPrivateFileSystemSink(filename: string): Promise<TextChunkSink | null> {
	const storage = navigator.storage;
	if (typeof storage?.getDirectory !== 'function') return null;

	const directory = await storage.getDirectory();
	await removeStaleOriginPrivateFileSystemExports(directory);
	const temporaryName = `${OPFS_EXPORT_PREFIX}${crypto.randomUUID()}.json`;
	const handle = await directory.getFileHandle(temporaryName, { create: true });
	const removeTemporaryFile = async () => {
		try {
			await directory.removeEntry(temporaryName);
		} catch {
			// Cleanup is best-effort after the export has already succeeded or failed.
		}
	};
	let writable: FileSystemWritableFileStream;
	try {
		writable = await handle.createWritable();
	} catch (error) {
		await removeTemporaryFile();
		throw error;
	}
	let settled = false;

	return {
		write: (chunk) => writable.write(chunk),
		async close() {
			if (settled) return;
			await writable.close();
			settled = true;
			try {
				const file = await handle.getFile();
				downloadFile(file, filename);
			} finally {
				await removeTemporaryFile();
			}
		},
		async abort(reason) {
			if (settled) return;
			settled = true;
			try {
				await writable.abort(reason);
			} catch {
				// The stream may already be errored; the temporary entry is still removable.
			} finally {
				await removeTemporaryFile();
			}
		},
	};
}

export async function openIncrementalJsonDownload(filename: string): Promise<TextChunkSink> {
	const pickerSink = await openPickerSink(filename);
	if (pickerSink) return pickerSink;

	const originPrivateFileSystemSink = await openOriginPrivateFileSystemSink(filename);
	if (originPrivateFileSystemSink) return originPrivateFileSystemSink;

	throw new Error('This browser does not support streaming account-export downloads');
}

function bufferedSink(destination: TextChunkSink): TextChunkSink {
	const encoder = new TextEncoder();
	const encodedScratch = new Uint8Array(MAX_DESTINATION_WRITE_BYTES);
	let buffer = '';
	let bufferedBytes = 0;
	const flush = async () => {
		if (!buffer) return;
		const chunk = buffer;
		buffer = '';
		bufferedBytes = 0;
		await destination.write(chunk);
	};
	return {
		async write(chunk) {
			let remaining = chunk;
			while (remaining) {
				const availableBytes = MAX_DESTINATION_WRITE_BYTES - bufferedBytes;
				const encodingTarget =
					availableBytes === MAX_DESTINATION_WRITE_BYTES
						? encodedScratch
						: encodedScratch.subarray(0, availableBytes);
				const { read, written } = encoder.encodeInto(remaining, encodingTarget);
				if (read === 0) {
					await flush();
					continue;
				}
				buffer += remaining.slice(0, read);
				bufferedBytes += written;
				remaining = remaining.slice(read);
				if (bufferedBytes === MAX_DESTINATION_WRITE_BYTES || remaining) {
					await flush();
				}
			}
		},
		async close() {
			await flush();
			await destination.close();
		},
		async abort(reason) {
			buffer = '';
			bufferedBytes = 0;
			await destination.abort(reason);
		},
	};
}

export async function writeJsonDownload(
	sink: TextChunkSink,
	document: JsonValueWriter
): Promise<void> {
	const buffered = bufferedSink(sink);
	try {
		await document(buffered);
		await buffered.close();
	} catch (error) {
		try {
			await buffered.abort(error);
		} catch {
			// Preserve the export failure even if rolling back the destination also fails.
		}
		throw error;
	}
}
