export interface TextChunkSink {
	write(chunk: string): Promise<void>;
	close(): Promise<void>;
	abort(reason?: unknown): Promise<void>;
}

export type JsonValueWriter = (sink: TextChunkSink) => Promise<void>;

type JsonObjectEntry = readonly [key: string, value: JsonValueWriter];
const WRITE_BUFFER_SIZE = 64 * 1024;

function asAsyncIterable<T>(values: Iterable<T> | AsyncIterable<T>): AsyncIterable<T> {
	if (Symbol.asyncIterator in values) return values;
	return {
		async *[Symbol.asyncIterator]() {
			yield* values;
		},
	};
}

export function jsonValue(value: unknown): JsonValueWriter {
	return async (sink) => {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) {
			throw new TypeError('Account export contains a value that cannot be serialized');
		}
		await sink.write(serialized);
	};
}

export function jsonArray(
	items: Iterable<JsonValueWriter> | AsyncIterable<JsonValueWriter>
): JsonValueWriter {
	return async (sink) => {
		await sink.write('[');
		let needsComma = false;
		for await (const item of asAsyncIterable(items)) {
			if (needsComma) await sink.write(',');
			await item(sink);
			needsComma = true;
		}
		await sink.write(']');
	};
}

export function jsonObject(
	entries: Iterable<JsonObjectEntry> | AsyncIterable<JsonObjectEntry>
): JsonValueWriter {
	return async (sink) => {
		await sink.write('{');
		let needsComma = false;
		for await (const [key, value] of asAsyncIterable(entries)) {
			if (needsComma) await sink.write(',');
			await sink.write(`${JSON.stringify(key)}:`);
			await value(sink);
			needsComma = true;
		}
		await sink.write('}');
	};
}

function firstNonWhitespaceIndex(value: string): number {
	return value.search(/\S/);
}

export function jsonObjectWithStreamedProperties(
	metadata: Record<string, unknown>,
	content: ReadableStream<Uint8Array>
): JsonValueWriter {
	return async (sink) => {
		const serializedMetadata = JSON.stringify(metadata);
		await sink.write(serializedMetadata.slice(0, -1));
		const metadataHasProperties = serializedMetadata !== '{}';
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
	const handle = await pickerWindow.showSaveFilePicker({
		suggestedName: filename,
		types: [
			{
				description: 'JSON data',
				accept: { 'application/json': ['.json'] },
			},
		],
	});
	const writable = await handle.createWritable();
	return {
		write: (chunk) => writable.write(chunk),
		close: () => writable.close(),
		abort: (reason) => writable.abort(reason),
	};
}

async function openOriginPrivateFileSystemSink(filename: string): Promise<TextChunkSink | null> {
	const storage = navigator.storage;
	if (typeof storage?.getDirectory !== 'function') return null;

	const directory = await storage.getDirectory();
	const temporaryName = `.owlat-account-export-${crypto.randomUUID()}.json`;
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
	let buffer = '';
	const flush = async () => {
		if (!buffer) return;
		const chunk = buffer;
		buffer = '';
		await destination.write(chunk);
	};
	return {
		async write(chunk) {
			if (chunk.length >= WRITE_BUFFER_SIZE) {
				await flush();
				await destination.write(chunk);
				return;
			}
			if (buffer.length + chunk.length > WRITE_BUFFER_SIZE) await flush();
			buffer += chunk;
		},
		async close() {
			await flush();
			await destination.close();
		},
		async abort(reason) {
			buffer = '';
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
