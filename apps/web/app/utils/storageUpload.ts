import type { Id } from '@owlat/api/dataModel';
import { decodeJsonValue, parserDecoder } from '@owlat/worker-protocol/decodeJson';
import { isRecord } from '@owlat/shared/utils/guards';
import { holdPendingWork } from '~/lib/pendingOperations';

export type StorageUploadResult =
	| { ok: true; storageId: Id<'_storage'> }
	| { ok: false; reason: 'no-url' | 'upload-failed' | 'no-storage-id' };

/**
 * The body a Convex storage upload answers with: `{ "storageId": "<id>" }`.
 * Anything else (a non-object, an id that is not a nonempty string) is a
 * failed upload, so a bad answer never reaches an attachment or media write.
 */
export const storageUploadResponseDecoder = parserDecoder(
	(value): Id<'_storage'> | null =>
		isRecord(value) && typeof value['storageId'] === 'string' && value['storageId'].length > 0
			? (value['storageId'] as Id<'_storage'>)
			: null,
	'$.storageId: expected a nonempty string'
);

/**
 * The storage id in an upload response body already read as JSON, or null
 * when it carries none (`undefined` stands for a body that was not JSON).
 */
export function uploadedStorageId(body: unknown): Id<'_storage'> | null {
	const decoded = decodeJsonValue(body, storageUploadResponseDecoder);
	return decoded.ok ? decoded.value : null;
}

/**
 * Shared core of every Convex storage upload: mint an upload URL, POST the file,
 * and parse the returned storageId. Every upload goes through here so the
 * generate-URL → POST → parse-storageId sequence has one error handling.
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

	const body: unknown = await response.json().catch(() => undefined);
	const storageId = uploadedStorageId(body);
	if (storageId === null) return { ok: false, reason: 'no-storage-id' };
	return { ok: true, storageId };
}
