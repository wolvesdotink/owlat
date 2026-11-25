/**
 * The shape of one operation in the table of `./operations.ts`, and the path
 * and query parameters several operations share.
 */

import type { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './common';
import {
	SEND_LIST_MAX_WINDOW_DAYS,
	TRANSACTIONAL_SEND_STATUSES,
	type ApiErrorReason,
} from './types';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** A key scope one operation requires. */
export type PublicApiScope =
	| 'contacts:read'
	| 'contacts:write'
	| 'events:write'
	| 'transactional:send'
	| 'topics:write'
	| 'topics:read'
	| 'status:read'
	| 'domains:verify';

/** The `scope` of an operation every authenticated key may call, whatever its scopes. */
export const ANY_KEY = 'any_key';

export interface PathParameter {
	name: string;
	description: string;
}

export interface QueryParameter {
	name: string;
	description: string;
	schema: Record<string, unknown>;
}

export interface PublicOperation {
	operationId: string;
	method: HttpMethod;
	/** The path with `{name}` placeholders for its path parameters. */
	path: string;
	tag: 'Contacts' | 'Events' | 'Transactional' | 'Topics' | 'Status' | 'Domains' | 'Health';
	summary: string;
	/**
	 * The key scope the operation needs: {@link ANY_KEY} when any key may call
	 * it, `null` for the unauthenticated probe.
	 */
	scope: PublicApiScope | typeof ANY_KEY | null;
	pathParameters: readonly PathParameter[];
	queryParameters: readonly QueryParameter[];
	/** Whether an `Idempotency-Key` header makes a repeat answer with the first response. */
	idempotent: boolean;
	/** Name of the request body in the document's components, and its schema. */
	request: { name: string; schema: z.ZodType } | null;
	/**
	 * The success status and what its envelope carries: `{ data }` with one
	 * item, or `{ data: [...], pagination }` when `paginated`. A `cursor` list
	 * has no `totalItems` in its pagination. `name` is the item's name in the
	 * document's components.
	 */
	success: {
		status: number;
		description: string;
		name: string;
		data: z.ZodType;
		paginated: boolean | 'cursor';
	};
	/** Error statuses the operation answers with, beyond the ones every keyed call can. */
	errors: readonly number[];
	/** The `error.data.reason` codes the operation answers with, beyond the ones every keyed call can. */
	reasons: readonly ApiErrorReason[];
}

/** Statuses every key-authenticated call can answer with. */
export const KEYED_ERROR_STATUSES = [400, 401, 403, 429, 500] as const;

export const CONTACT_REF: PathParameter = {
	name: 'id',
	description: 'The contact ID, or the contact email address (URL-encoded).',
};
export const TOPIC_ID: PathParameter = { name: 'topicId', description: 'The topic ID.' };

export const PAGE_LIMIT: QueryParameter = {
	name: 'limit',
	description: `Items per page, at most ${MAX_PAGE_SIZE}; a larger value is clamped.`,
	schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
};
export const PAGE_CURSOR: QueryParameter = {
	name: 'cursor',
	description: "The previous page's `pagination.cursor`. Omit it for the first page.",
	schema: { type: 'string' },
};

export const SEND_ID: PathParameter = {
	name: 'sendId',
	description: 'The `transactionalEmailId` the send call answered with.',
};

export const SEND_LIST_FILTERS: readonly QueryParameter[] = [
	{
		name: 'email',
		description:
			'Only sends to this recipient address, matched exactly after trimming and lowercasing. Can be combined with `status`.',
		schema: { type: 'string', format: 'email' },
	},
	{
		name: 'status',
		description: 'Only sends in this delivery state. Can be combined with `email`.',
		schema: { type: 'string', enum: [...TRANSACTIONAL_SEND_STATUSES] },
	},
	{
		name: 'since',
		description: `ISO 8601 timestamp: only sends queued at or after it. Defaults to ${SEND_LIST_MAX_WINDOW_DAYS} days before \`until\`, and may be at most that long before it.`,
		schema: { type: 'string', format: 'date-time' },
	},
	{
		name: 'until',
		description: 'ISO 8601 timestamp: only sends queued before it. Defaults to now.',
		schema: { type: 'string', format: 'date-time' },
	},
];

/**
 * `GET /api/v1/limits` names one template and one address with these, the way
 * the send body names them, to read their per-recipient count.
 */
export const LIMITS_RECIPIENT_QUERY: readonly QueryParameter[] = [
	{
		name: 'email',
		description:
			'With `slug` or `transactionalId`: the address whose count to read, matched after trimming and lowercasing. Needs the `transactional:send` scope.',
		schema: { type: 'string', format: 'email' },
	},
	{
		name: 'slug',
		description: 'With `email`: the slug of the template whose count to read.',
		schema: { type: 'string' },
	},
	{
		name: 'transactionalId',
		description: 'With `email`: the ID of the template whose count to read. Wins over `slug`.',
		schema: { type: 'string' },
	},
];
