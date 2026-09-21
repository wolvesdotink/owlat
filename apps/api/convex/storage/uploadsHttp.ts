import { httpAction, type ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { BodyTooLargeError, readBodyText } from '../lib/readBody';
import { errorResponse, jsonResponse } from '../lib/httpResponse';
import { getOptional } from '../lib/env';
import { safeCompare } from '../lib/safeCompare';
import type { Id } from '../_generated/dataModel';

/** Only the web server sees native upload responses and can attest blob ownership.
 * File bytes stream through Nuxt to native storage, never through a Convex HTTP
 * action (whose request limit is below the supported archive/library size).
 */
function authenticated(request: Request): boolean {
	const current = getOptional('INSTANCE_SECRET');
	if (!current) return false;
	const header = request.headers.get('authorization') ?? '';
	if (!header.startsWith('Bearer ')) return false;
	const token = header.slice(7);
	const previous = getOptional('INSTANCE_SECRET_PREVIOUS');
	return safeCompare(token, current) || (previous !== undefined && safeCompare(token, previous));
}

async function serviceRequest(
	ctx: ActionCtx,
	request: Request,
	operation: 'begin' | 'finish' | 'abort'
): Promise<Response> {
	if (!authenticated(request)) return errorResponse('unauthenticated', 'Unauthorized');
	try {
		const body: unknown = JSON.parse(await readBodyText(request, 10 * 1024));
		if (!body || typeof body !== 'object' || Array.isArray(body))
			return errorResponse('invalid_input', 'Invalid upload request');
		const fields = body as Record<string, unknown>;
		if (operation === 'begin') {
			if (typeof fields['token'] !== 'string' || fields['token'].length > 100)
				return errorResponse('invalid_input', 'Invalid upload token');
			const uploadId = await ctx.runMutation(internal.storage.uploads.begin, {
				token: fields['token'],
			});
			if (!uploadId) return errorResponse('unauthenticated', 'Invalid or expired upload token');
			const uploadUrl = await ctx.storage.generateUploadUrl();
			return jsonResponse({ uploadId, uploadUrl });
		}
		if (
			typeof fields['uploadId'] !== 'string' ||
			fields['uploadId'].length > 100 ||
			(fields['storageId'] !== undefined &&
				(typeof fields['storageId'] !== 'string' || fields['storageId'].length > 100))
		)
			return errorResponse('invalid_input', 'Invalid upload receipt');
		const uploadId = fields['uploadId'] as Id<'storageUploads'>;
		const storageId = fields['storageId'] as Id<'_storage'> | undefined;
		if (operation === 'abort') {
			await ctx.runMutation(internal.storage.uploads.abort, { uploadId, storageId });
			return jsonResponse({ ok: true });
		}
		if (!storageId) return errorResponse('invalid_input', 'Missing storage id');
		await ctx.runMutation(internal.storage.uploads.finish, { uploadId, storageId });
		return jsonResponse({ storageId });
	} catch (error) {
		return error instanceof BodyTooLargeError
			? errorResponse('limit_reached', 'Upload receipt too large')
			: errorResponse('invalid_input', 'Invalid or expired upload request');
	}
}

export const beginUpload = httpAction((ctx, request) => serviceRequest(ctx, request, 'begin'));
export const finishUpload = httpAction((ctx, request) => serviceRequest(ctx, request, 'finish'));
export const abortUpload = httpAction((ctx, request) => serviceRequest(ctx, request, 'abort'));
