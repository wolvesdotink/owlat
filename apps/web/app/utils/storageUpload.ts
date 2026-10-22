import type { Id } from '@owlat/api/dataModel';
import { holdPendingWork } from '~/lib/pendingOperations';

export type StorageUploadResult =
	| { ok: true; storageId: Id<'_storage'> }
	| { ok: false; reason: 'no-url' | 'upload-failed' | 'no-storage-id' };

/**
 * Shared core of every Convex storage upload: mint an upload URL, POST the file,
 * and parse the returned storageId. Previously this generate-URL → POST →
 * parse-storageId sequence was hand-written in ~6 places with subtly different
 * error handling.
 *
 * Returns a discriminated result so each caller keeps its own UX for the three
 * failure modes (toast / throw / silent skip). `generateUploadUrl` is a
 * `useBackendOperation` `run` — a failed mint has already been surfaced by the
 * operation module, so it lands here as the `no-url` reason and nothing else.
 * The POST itself may still throw on a transport error — callers that swallow
 * that wrap this call in try/catch.
 *
 * The transfer holds any slow-save episode open (`holdPendingWork`): neither
 * the mint nor the POST is a tracked write, and a write that lands meanwhile
 * must not confirm "all changes saved" while this file is still on its way.
 * This hold ends with the transfer; a caller whose save goes on afterwards
 * (measuring, registering, resolving a URL, handing the result over) holds
 * its whole flow itself.
 */
export async function uploadFileToStorage(
	file: File,
	generateUploadUrl: () => Promise<BackendOperationResult<string>>,
	contentType: string = file.type
): Promise<StorageUploadResult> {
	const release = holdPendingWork();
	let result: StorageUploadResult = { ok: false, reason: 'upload-failed' };
	try {
		result = await transfer(file, generateUploadUrl, contentType);
		return result;
	} finally {
		release(result.ok);
	}
}

async function transfer(
	file: File,
	generateUploadUrl: () => Promise<BackendOperationResult<string>>,
	contentType: string
): Promise<StorageUploadResult> {
	const minted = await generateUploadUrl();
	if (!minted.ok) return { ok: false, reason: 'no-url' };

	const response = await fetch(minted.result, {
		method: 'POST',
		headers: { 'Content-Type': contentType },
		body: file,
	});
	if (!response.ok) return { ok: false, reason: 'upload-failed' };

	const json = (await response.json()) as { storageId?: Id<'_storage'> };
	if (typeof json?.storageId !== 'string') return { ok: false, reason: 'no-storage-id' };
	return { ok: true, storageId: json.storageId };
}
