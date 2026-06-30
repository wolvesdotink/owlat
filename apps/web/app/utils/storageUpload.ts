import type { Id } from '@owlat/api/dataModel';

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
 * failure modes (toast / throw / silent skip). The POST itself may still throw on
 * a transport error — callers that swallow that wrap this call in try/catch.
 */
export async function uploadFileToStorage(
	file: File,
	generateUploadUrl: () => Promise<string | undefined>,
	contentType: string = file.type,
): Promise<StorageUploadResult> {
	const uploadUrl = await generateUploadUrl();
	if (uploadUrl === undefined) return { ok: false, reason: 'no-url' };

	const response = await fetch(uploadUrl, {
		method: 'POST',
		headers: { 'Content-Type': contentType },
		body: file,
	});
	if (!response.ok) return { ok: false, reason: 'upload-failed' };

	const json = (await response.json()) as { storageId?: Id<'_storage'> };
	if (typeof json?.storageId !== 'string') return { ok: false, reason: 'no-storage-id' };
	return { ok: true, storageId: json.storageId };
}
