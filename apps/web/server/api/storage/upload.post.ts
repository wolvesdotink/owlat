import { Readable } from 'node:stream';
import { defineEventHandler, createError, getHeader, getQuery, setHeader } from 'h3';
import { MAX_ARCHIVE_IMPORT_BYTES } from '@owlat/shared/mboxArchive';
import { getInstanceSecret } from '../../utils/updater';

/** Stream bytes to native Convex storage; only this server can attest the returned id. */
export default defineEventHandler(async (event) => {
	setHeader(event, 'Cache-Control', 'no-store');
	const token = getQuery(event)['token'];
	if (typeof token !== 'string' || !token || token.length > 100) {
		throw createError({ statusCode: 401, message: 'Invalid upload token' });
	}
	if (Number(getHeader(event, 'content-length')) > MAX_ARCHIVE_IMPORT_BYTES) {
		throw createError({ statusCode: 413, message: 'File too large' });
	}
	const secret = getInstanceSecret('File uploads are not configured');
	const config = useRuntimeConfig();
	const siteUrl = config.convexSiteUrlInternal || config.public.convexSiteUrl;
	if (!siteUrl) throw createError({ statusCode: 503, message: 'File uploads are not configured' });
	const control = async (operation: string, body: object) => {
		return await fetch(`${String(siteUrl).replace(/\/$/, '')}/storage/upload/${operation}`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			redirect: 'error',
			signal: AbortSignal.timeout(15_000),
		});
	};
	const begin = await control('begin', { token });
	if (!begin.ok) {
		void begin.body?.cancel().catch(() => undefined);
		throw createError({
			statusCode: begin.status === 401 ? 401 : 502,
			message: 'Upload unavailable or token expired',
		});
	}
	const { uploadId, uploadUrl } = (await begin.json()) as { uploadId: string; uploadUrl: string };
	let storageId: string | undefined;
	let isTooLarge = false;
	try {
		let size = 0;
		// Count queued bytes, not chunks: Node's default WebStream strategy can
		// otherwise buffer thousands of large chunks while storage reads slowly.
		const body = (
			Readable.toWeb(event.node.req, {
				strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
			}) as unknown as ReadableStream<Uint8Array>
		).pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					size += chunk.byteLength;
					if (size > MAX_ARCHIVE_IMPORT_BYTES) {
						isTooLarge = true;
						controller.error(new Error('File too large'));
						return;
					}
					controller.enqueue(chunk);
				},
			})
		);
		const native = await fetch(uploadUrl, {
			method: 'POST',
			headers: { 'Content-Type': getHeader(event, 'content-type') ?? 'application/octet-stream' },
			body,
			duplex: 'half',
			redirect: 'error',
			signal: AbortSignal.timeout(5 * 60_000),
		} as RequestInit & { duplex: 'half' });
		if (!native.ok) {
			void native.body?.cancel().catch(() => undefined);
			throw new Error('Storage rejected upload');
		}
		const result = (await native.json()) as { storageId?: unknown };
		if (typeof result.storageId !== 'string') throw new Error('Invalid storage response');
		storageId = result.storageId;
		const finish = await control('finish', { uploadId, storageId });
		void finish.body?.cancel().catch(() => undefined);
		if (!finish.ok) throw new Error('Upload receipt could not be saved');
		return { storageId };
	} catch {
		// This id came from the native upload response, never from browser input.
		await control('abort', { uploadId, storageId }).then(
			(response) => {
				void response.body?.cancel().catch(() => undefined);
			},
			() => undefined
		);
		throw createError({
			statusCode: isTooLarge ? 413 : 502,
			message: isTooLarge ? 'File too large' : 'Upload failed; request a new upload URL',
		});
	}
});
