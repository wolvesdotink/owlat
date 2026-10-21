/**
 * Idempotency receipts for the key-authed send endpoints
 * (`POST /api/v1/transactional`, `POST /api/v1/events`).
 *
 * A caller that sends an `Idempotency-Key` header gets at most one set of
 * effects per key. The mutation that performs the send looks the key up first:
 *
 *   - no live receipt: it does the work and writes the receipt in the SAME
 *     transaction, so there is no in-flight state to reconcile. A request that
 *     failed before commit left neither the effects nor the receipt; one whose
 *     response was lost after commit is answered from the receipt.
 *   - a receipt for the same endpoint and request: it returns the stored
 *     response without touching anything else.
 *   - a receipt for a different request: it refuses with `conflict` (409).
 *
 * Concurrent requests with one key are serialized by the mutation's read of the
 * key's index range: the loser of the race re-runs and finds the winner's row.
 *
 * Keys are scoped to the organization. The fingerprint covers the endpoint and
 * the validated request, attachment bytes included (as their digests), and is
 * computed before any upload exists, so storage ids and signed URLs never feed
 * it. Receipts expire after {@link RECEIPT_TTL_MS}; a lookup ignores an expired
 * row whatever the sweep has done, and a request under that key starts afresh.
 */

import { v, type Infer } from 'convex/values';
import { canonicalJson } from '@owlat/shared/canonicalJson';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import {
	internalQuery,
	type ActionCtx,
	type MutationCtx,
	type QueryCtx,
} from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { bytesToHex } from '../lib/bytes';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { receiptEndpointValidator } from '../schema/apiRequestReceipts';
import { errorResponse } from './apiResponses';

/** Request header carrying the caller's key. */
const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** Response header set to `true` on a response answered from a receipt. */
const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/** How long a key keeps answering for its first request. */
export const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

/** Longest accepted key. A UUID is 36 characters. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/** Printable ASCII without spaces, so a key survives every HTTP stack unchanged. */
const KEY_PATTERN = /^[\x21-\x7e]+$/;

const SWEEP_BATCH = 200;

export const IDEMPOTENCY_CONFLICT_MESSAGE =
	'This Idempotency-Key was already used for a different request. Use a new key for a new request.';

type ReceiptEndpoint = Infer<typeof receiptEndpointValidator>;

/** What a send mutation needs to honour a key. */
export const idempotencyArgValidator = v.object({
	organizationId: v.string(),
	key: v.string(),
	requestHash: v.string(),
});
export type IdempotencyArg = Infer<typeof idempotencyArgValidator>;

// ============================================================
// HTTP side: header, fingerprint, organization
// ============================================================

type KeyRead = { ok: true; key: string | null } | { ok: false; message: string };

/** The request's `Idempotency-Key`, `null` when absent, or why it is unusable. */
export function readIdempotencyKey(request: Request): KeyRead {
	const raw = request.headers.get(IDEMPOTENCY_KEY_HEADER);
	if (raw === null) return { ok: true, key: null };
	if (raw.length === 0 || raw.length > MAX_IDEMPOTENCY_KEY_LENGTH || !KEY_PATTERN.test(raw)) {
		return {
			ok: false,
			message: `${IDEMPOTENCY_KEY_HEADER} must be 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} printable ASCII characters without spaces`,
		};
	}
	return { ok: true, key: raw };
}

/** Lower-case hex SHA-256 of `bytes`. */
export async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
	return bytesToHex(digest);
}

/**
 * Fingerprint of one request: the endpoint plus the validated request in
 * canonical JSON (keys sorted), so key order and whitespace in the body do not
 * make the same request look different.
 */
export async function requestFingerprint(
	endpoint: ReceiptEndpoint,
	request: unknown
): Promise<string> {
	return sha256HexOfBytes(new TextEncoder().encode(canonicalJson({ endpoint, request })));
}

/**
 * The idempotency argument for a send mutation, or `undefined` when the caller
 * sent no key. `fingerprintInput` is only built when a key is present, so an
 * unkeyed request pays nothing for it.
 */
export async function resolveIdempotency(
	ctx: ActionCtx,
	key: string | null,
	endpoint: ReceiptEndpoint,
	fingerprintInput: () => unknown
): Promise<IdempotencyArg | undefined> {
	if (key === null) return undefined;
	const requestHash = await requestFingerprint(endpoint, await fingerprintInput());
	const organizationId = await getSingletonOrganizationId(ctx);
	return { organizationId, key, requestHash };
}

/** The 409 for a key reused with a different request. */
export function idempotencyConflictResponse(): Response {
	return errorResponse('conflict', IDEMPOTENCY_CONFLICT_MESSAGE, {
		data: { reason: 'idempotency_conflict' },
	});
}

/** Headers marking a response that was answered from a receipt. */
export function replayHeaders(replayed: boolean | undefined): Record<string, string> {
	return replayed ? { [IDEMPOTENT_REPLAYED_HEADER]: 'true' } : {};
}

// ============================================================
// Transaction side: lookup and write
// ============================================================

export type ReceiptLookup =
	| { kind: 'absent' }
	| { kind: 'replay'; receipt: Doc<'apiRequestReceipts'> }
	| { kind: 'conflict' };

/** Classify a stored row against the incoming request. Expired rows count as absent. */
export function classifyReceipt(
	receipt: Doc<'apiRequestReceipts'> | null,
	endpoint: ReceiptEndpoint,
	requestHash: string,
	now: number
): ReceiptLookup {
	if (!receipt || receipt.expiresAt <= now) return { kind: 'absent' };
	if (receipt.endpoint === endpoint && receipt.requestHash === requestHash) {
		return { kind: 'replay', receipt };
	}
	return { kind: 'conflict' };
}

async function findReceipt(
	db: QueryCtx['db'],
	idempotency: IdempotencyArg
): Promise<Doc<'apiRequestReceipts'> | null> {
	return await db
		.query('apiRequestReceipts')
		.withIndex('by_org_key', (q) =>
			q.eq('organizationId', idempotency.organizationId).eq('idempotencyKey', idempotency.key)
		)
		.first();
}

/**
 * Look the key up inside the send's transaction. An expired row is deleted
 * here, so the receipt this request writes is the key's only row.
 */
export async function lookupReceipt(
	ctx: MutationCtx,
	endpoint: ReceiptEndpoint,
	idempotency: IdempotencyArg
): Promise<ReceiptLookup> {
	const receipt = await findReceipt(ctx.db, idempotency);
	const lookup = classifyReceipt(receipt, endpoint, idempotency.requestHash, Date.now());
	if (receipt && lookup.kind === 'absent') await ctx.db.delete(receipt._id);
	return lookup;
}

/** The response fields a receipt keeps, per endpoint. */
type ReceiptResponse =
	| {
			endpoint: 'transactional';
			contactId: Doc<'apiRequestReceipts'>['contactId'];
			contactCreated: boolean;
			sendId: NonNullable<Doc<'apiRequestReceipts'>['sendId']>;
			language: string;
	  }
	| {
			endpoint: 'events';
			contactId: Doc<'apiRequestReceipts'>['contactId'];
			contactCreated: boolean;
			eventId: string;
			triggeredAutomations: number;
	  };

/** Record the response, in the transaction that produced its effects. */
export async function writeReceipt(
	ctx: MutationCtx,
	idempotency: IdempotencyArg,
	response: ReceiptResponse
): Promise<void> {
	const now = Date.now();
	const { contactCreated, ...fields } = response;
	await ctx.db.insert('apiRequestReceipts', {
		organizationId: idempotency.organizationId,
		idempotencyKey: idempotency.key,
		requestHash: idempotency.requestHash,
		...fields,
		isContactCreated: contactCreated,
		createdAt: now,
		expiresAt: now + RECEIPT_TTL_MS,
	});
}

type StoredResponse<E extends ReceiptEndpoint> = Omit<
	Extract<ReceiptResponse, { endpoint: E }>,
	'endpoint'
>;

/** A transactional receipt's response; a row missing its send is corrupt. */
export function storedTransactionalResponse(
	receipt: Doc<'apiRequestReceipts'>
): StoredResponse<'transactional'> {
	if (receipt.sendId === undefined || receipt.language === undefined) {
		throw new Error(`Idempotency receipt ${receipt._id} is missing its send`);
	}
	return {
		contactId: receipt.contactId,
		contactCreated: receipt.isContactCreated,
		sendId: receipt.sendId,
		language: receipt.language,
	};
}

/** An events receipt's response; a row missing its event is corrupt. */
export function storedEventResponse(receipt: Doc<'apiRequestReceipts'>): StoredResponse<'events'> {
	if (receipt.eventId === undefined || receipt.triggeredAutomations === undefined) {
		throw new Error(`Idempotency receipt ${receipt._id} is missing its event`);
	}
	return {
		contactId: receipt.contactId,
		contactCreated: receipt.isContactCreated,
		eventId: receipt.eventId,
		triggeredAutomations: receipt.triggeredAutomations,
	};
}

/**
 * Read-only lookup for the HTTP shell, so a repeated transactional request is
 * answered before its attachments are stored again. Advisory: the send's own
 * transaction repeats the lookup and decides.
 */
export const peekReceipt = internalQuery({
	args: { endpoint: receiptEndpointValidator, idempotency: idempotencyArgValidator },
	handler: async (ctx, args): Promise<ReceiptLookup> => {
		const receipt = await findReceipt(ctx.db, args.idempotency);
		return classifyReceipt(receipt, args.endpoint, args.idempotency.requestHash, Date.now());
	},
});

/** Delete expired receipts in bounded batches, continuing while a batch comes back full. */
export const sweepExpired = internalMutation({
	args: {},
	handler: async (ctx): Promise<number> => {
		const expired = await ctx.db
			.query('apiRequestReceipts')
			.withIndex('by_expiry', (q) => q.lte('expiresAt', Date.now()))
			.take(SWEEP_BATCH);
		for (const receipt of expired) {
			await ctx.db.delete(receipt._id);
		}
		if (expired.length === SWEEP_BATCH) {
			await ctx.scheduler.runAfter(0, internal.auth.apiRequestReceipts.sweepExpired, {});
		}
		return expired.length;
	},
});
