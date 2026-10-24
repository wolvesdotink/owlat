/**
 * Attachment intake for the transactional send HTTP shell (`transactional/api.ts`):
 * validate and decode the whole attachment list, store the bytes, and hand
 * them to the dispatch mutation.
 *
 * Storage writes are action-only, so they happen here, before the dispatch
 * transaction decides. The pending-upload handoff in `pendingUploads.ts` is
 * what keeps a refused or interrupted request from leaving its bytes behind.
 */

import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { ActionCtx } from '../_generated/server';
import { errorResponse } from '../auth/apiResponses';
import type { JsonPrimitiveValue } from '../lib/inputGuards';
import { validateOutboundUrl } from '../lib/outboundUrlValidation';
import { ATTACHMENT_COMPOSE_LIMITS } from '@owlat/shared/attachments';
import type { AttachmentRef, DispatchOutcome } from './dispatch';
import { discardStoredUploads, type StoredUpload } from './pendingUploads';
import type { IdempotencyArg } from '../auth/apiRequestReceipts';
import type { TransactionalAttachment } from '@owlat/public-contract';

const MAX_TOTAL_SIZE = ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes;

/** An attachment that passed every check: a URL to pass through, or decoded bytes. */
export type PreparedAttachment =
	| { filename: string; contentType?: string; url: string }
	| { filename: string; contentType?: string; bytes: Uint8Array };

type PrepareResult =
	| { ok: true; prepared: PreparedAttachment[] }
	| { ok: false; response: Response };

function invalidAttachment(message: string): { ok: false; response: Response } {
	return { ok: false, response: errorResponse('invalid_input', message) };
}

/** Strict base64 (atob's alphabet and padding rules) straight into bytes. */
function decodeBase64(content: string): Uint8Array | null {
	let binary: string;
	try {
		binary = atob(content);
	} catch {
		return null;
	}
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * Check the WHOLE attachment list (URL safety, base64, the decoded-size
 * budget) and decode it, before a single byte is stored: a bad third
 * attachment must not leave the first two behind. The list's shape (a
 * filename without path separators, exactly one of `content` or `url`, each a
 * string) is the public contract's, already checked when the request was
 * decoded.
 */
export function prepareAttachments(
	attachments: readonly TransactionalAttachment[] | undefined
): PrepareResult {
	const prepared: PreparedAttachment[] = [];
	let totalDecodedSize = 0;

	for (const [i, att] of (attachments ?? []).entries()) {
		if (att.url !== undefined) {
			// This URL is fetched server-side later, so a `startsWith('https://')`
			// check is not enough: parse it and reject non-https, embedded
			// credentials, and hosts that are literal private/internal addresses
			// (SSRF). DNS-time range enforcement is applied again at the fetch site.
			const urlCheck = validateOutboundUrl(att.url, { requirePublic: true });
			if (!urlCheck.ok) {
				return invalidAttachment(`attachments[${i}].url ${urlCheck.error}`);
			}
			prepared.push({ filename: att.filename, contentType: att.contentType, url: att.url });
			continue;
		}

		// Base64 content path: decode and count bytes against the budget. The
		// contract's shape check guarantees `content` here; the guard keeps an
		// undecoded caller from storing an empty file.
		if (att.content === undefined) {
			return invalidAttachment(
				`attachments[${i}] must have exactly one of "content" (base64) or "url"`
			);
		}
		const bytes = decodeBase64(att.content);
		if (!bytes) {
			return invalidAttachment(`attachments[${i}].content is not valid base64`);
		}
		totalDecodedSize += bytes.byteLength;
		if (totalDecodedSize > MAX_TOTAL_SIZE) {
			return invalidAttachment(
				`Total attachment size exceeds ${MAX_TOTAL_SIZE / (1024 * 1024)}MB limit`
			);
		}
		prepared.push({ filename: att.filename, contentType: att.contentType, bytes });
	}

	return { ok: true, prepared };
}

type AttachmentUploadResult =
	| { ok: true; refs: AttachmentRef[] | undefined }
	| { ok: false; response: Response };

/**
 * Store the decoded attachments in Convex storage; pass HTTPS URL attachments
 * through verbatim. Returns the prepared `AttachmentRef[]` the dispatch module
 * consumes (or undefined when there were no attachments).
 *
 * Requires action context (`ctx.storage.store` is action-only) — this is
 * why the HTTP shell handles attachments rather than the mutation-shaped
 * dispatch module. Every blob goes into `stored` the moment it exists and is
 * registered as a pending upload right after, so a later failure (a storage
 * error, a missing URL, a thrown mutation) leaves the caller holding every id
 * it has to undo (`transactional/pendingUploads.ts`).
 */
export async function uploadAttachments(
	ctx: Pick<ActionCtx, 'storage' | 'runMutation'>,
	prepared: readonly PreparedAttachment[],
	stored: StoredUpload[]
): Promise<AttachmentUploadResult> {
	const refs: AttachmentRef[] = [];

	for (const att of prepared) {
		if ('url' in att) {
			refs.push({ filename: att.filename, contentType: att.contentType, url: att.url });
			continue;
		}

		const contentType = att.contentType || 'application/octet-stream';
		const storageId = await ctx.storage.store(
			new Blob([att.bytes as BlobPart], { type: contentType })
		);
		const upload: StoredUpload = { storageId, registered: false };
		stored.push(upload);
		await ctx.runMutation(internal.transactional.pendingUploads.register, { storageId });
		upload.registered = true;

		const storageUrl = await ctx.storage.getUrl(storageId);
		if (!storageUrl) {
			return {
				ok: false,
				response: errorResponse('internal', 'Failed to store attachment'),
			};
		}

		refs.push({
			filename: att.filename,
			contentType: att.contentType,
			url: storageUrl,
			storageId,
		});
	}

	return { ok: true, refs: refs.length > 0 ? refs : undefined };
}

/** The dispatch arguments the shell settles before any attachment is stored. */
interface DispatchRequest {
	templateLookup: { kind: 'id'; id: Id<'transactionalEmails'> } | { kind: 'slug'; slug: string };
	email: string;
	dataVariables?: Record<string, JsonPrimitiveValue>;
	language?: string;
	idempotency?: IdempotencyArg;
}

/**
 * Store the attachments, then dispatch. Each stored blob stays pending until
 * dispatch claims it with the Send; every refusal (a storage failure, a
 * rejection, a thrown dispatch) releases what is still pending, and a request
 * that dies in between leaves it to the expiry sweep (`pendingUploads.ts`).
 * A replay of an Idempotency-Key claims nothing: the original Send owns its
 * own blobs, so this request's copies are released like a refusal's.
 */
export async function uploadAndDispatch(
	ctx: Pick<ActionCtx, 'storage' | 'runMutation'>,
	prepared: readonly PreparedAttachment[],
	request: DispatchRequest
): Promise<{ ok: true; outcome: DispatchOutcome } | { ok: false; response: Response }> {
	const stored: StoredUpload[] = [];
	let outcome: DispatchOutcome;
	try {
		const uploadResult = await uploadAttachments(ctx, prepared, stored);
		if (!uploadResult.ok) {
			await discardStoredUploads(ctx, stored);
			return uploadResult;
		}
		outcome = await ctx.runMutation(internal.transactional.dispatch.dispatch, {
			...request,
			attachmentRefs: uploadResult.refs,
		});
	} catch (err) {
		// Also covers a dispatch whose outcome is unknown: a claimed upload has
		// no pending row left, so the release cannot touch a queued Send's bytes.
		await discardStoredUploads(ctx, stored);
		throw err;
	}
	if (!outcome.ok || outcome.replayed) await discardStoredUploads(ctx, stored);
	return { ok: true, outcome };
}
