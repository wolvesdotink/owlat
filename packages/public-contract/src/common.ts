/**
 * Schemas for the envelopes, pagination and values every v1 operation shares.
 */

import { z } from 'zod';

/** A JSON primitive value; nested objects and arrays are not values. */
export const jsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * A flat object of JSON primitives, answering any shape fault with `message`.
 * The value union gets the same message, so a nested value reports the
 * field rather than the union's generic wording.
 */
export function jsonPrimitiveRecordSchema(message: string) {
	return z.record(
		z.string(),
		z.union([z.string(), z.number(), z.boolean(), z.null()], { error: message }),
		{ error: message }
	);
}

/**
 * A request body object. Unknown fields are accepted and ignored, so a newer
 * client talking to an older server keeps working.
 */
export function requestBody<Shape extends z.ZodRawShape>(shape: Shape) {
	return z.object(shape, { error: 'Request body must be a JSON object' });
}

/** A required string field: a missing or falsy value reads as missing. */
export function requiredString(requiredMessage: string, typeMessage: string) {
	return z
		.string({ error: (issue) => (issue.input ? typeMessage : requiredMessage) })
		.min(1, { error: requiredMessage });
}

/** An optional string field; `null` is a type fault. */
export function optionalString(typeMessage: string) {
	return z.string({ error: typeMessage }).optional();
}

export const paginationMetaSchema = z.strictObject({
	limit: z.number().int(),
	totalItems: z.number().int(),
	cursor: z.string().nullable(),
	isDone: z.boolean(),
});

/**
 * Response schemas are strict: the server sends exactly the documented
 * fields, so a test that parses a real response with one of them also catches
 * a field the contract does not know about.
 */

/** `{ data }`, the envelope of every single-item success response. */
export function dataEnvelope<Item extends z.ZodType>(item: Item) {
	return z.strictObject({ data: item });
}

/** `{ data, pagination }`, the envelope of a list response. */
export function paginatedEnvelope<Item extends z.ZodType>(item: Item) {
	return z.strictObject({ data: z.array(item), pagination: paginationMetaSchema });
}

export const apiErrorResponseSchema = z.strictObject({
	error: z.strictObject({
		category: z.string().meta({
			description:
				"The error's classification, such as `invalid_input`, `not_found`, `conflict` or `rate_limited`. New categories can be added; treat an unknown one by its HTTP status.",
		}),
		message: z.string(),
		data: z.record(z.string(), z.unknown()).optional(),
	}),
});

export const healthStatusSchema = z.strictObject({
	status: z.literal('ok'),
	timestamp: z.string(),
});

/** Largest page a list request returns; a larger `limit` is clamped to it. */
export const MAX_PAGE_SIZE = 100;

/** Page size of a list request without a `limit`. */
export const DEFAULT_PAGE_SIZE = 25;

/** A list request's query once read: `limit` resolved, `cursor` null for the first page. */
export interface ResolvedListQuery {
	limit: number;
	cursor: string | null;
	search?: string;
}

/**
 * Read a list request's `limit`, `cursor` and `search` query parameters. An
 * empty `limit` or `search` counts as absent, a `limit` above
 * {@link MAX_PAGE_SIZE} is clamped, and a `limit` that does not start with a
 * positive integer is refused.
 */
export function readListQuery(
	params: URLSearchParams
): { ok: true; value: ResolvedListQuery } | { ok: false; message: string } {
	const limit = Math.min(
		Number.parseInt(params.get('limit') || String(DEFAULT_PAGE_SIZE), 10),
		MAX_PAGE_SIZE
	);
	if (Number.isNaN(limit) || limit < 1) return { ok: false, message: 'Invalid limit' };
	const search = params.get('search') || undefined;
	return {
		ok: true,
		value: { limit, cursor: params.get('cursor'), ...(search === undefined ? {} : { search }) },
	};
}
