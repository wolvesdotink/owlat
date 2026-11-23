/**
 * Every operation of the public v1 API: method, path, the key scope it needs,
 * its parameters, request body and responses. The OpenAPI document is built
 * from this table, the server's route test checks its router against it, and
 * the Java SDK's tests check their calls against the generated document.
 *
 * Paths are written out in full, like the routes in the server's router:
 * these URLs live in customers' integration code.
 */

import type { z } from 'zod';
import {
	cursorPaginatedEnvelope,
	dataEnvelope,
	DEFAULT_PAGE_SIZE,
	healthStatusSchema,
	MAX_PAGE_SIZE,
	paginatedEnvelope,
} from './common';
import {
	contactSchema,
	createContactRequestSchema,
	deleteContactResponseSchema,
	updateContactRequestSchema,
} from './contacts';
import { sendingDomainSetupListSchema } from './domains';
import { sendEventRequestSchema, sendEventResponseSchema } from './events';
import { deliveryStatusSchema } from './status';
import {
	addContactToTopicRequestSchema,
	addToTopicResponseSchema,
	removeFromTopicResponseSchema,
	topicSchema,
} from './topics';
import {
	sendTransactionalRequestSchema,
	sendTransactionalResponseSchema,
	transactionalSendStatusSchema,
} from './transactional';
import { ERROR_REASON_STATUS } from './errors';
import {
	API_KEY_ERROR_REASONS,
	SEND_LIST_MAX_WINDOW_DAYS,
	TRANSACTIONAL_REFUSAL_REASONS,
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
	| 'status:read';

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
	/** The key scope the operation needs; `null` for the unauthenticated probe. */
	scope: PublicApiScope | null;
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

const CONTACT_REF: PathParameter = {
	name: 'id',
	description: 'The contact ID, or the contact email address (URL-encoded).',
};
const TOPIC_ID: PathParameter = { name: 'topicId', description: 'The topic ID.' };

const PAGE_LIMIT: QueryParameter = {
	name: 'limit',
	description: `Items per page, at most ${MAX_PAGE_SIZE}; a larger value is clamped.`,
	schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
};
const PAGE_CURSOR: QueryParameter = {
	name: 'cursor',
	description: "The previous page's `pagination.cursor`. Omit it for the first page.",
	schema: { type: 'string' },
};

const SEND_ID: PathParameter = {
	name: 'sendId',
	description: 'The `transactionalEmailId` the send call answered with.',
};

const SEND_LIST_FILTERS: readonly QueryParameter[] = [
	{
		name: 'email',
		description:
			'Only sends to this recipient address, matched exactly after trimming and lowercasing. Cannot be combined with `status`.',
		schema: { type: 'string', format: 'email' },
	},
	{
		name: 'status',
		description: 'Only sends in this delivery state. Cannot be combined with `email`.',
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

export const PUBLIC_OPERATIONS = [
	{
		operationId: 'getHealth',
		method: 'GET',
		path: '/api/v1/health',
		tag: 'Health',
		summary: 'Check that the API answers. Needs no API key.',
		scope: null,
		pathParameters: [],
		queryParameters: [],
		idempotent: false,
		request: null,
		success: {
			status: 200,
			description: 'The API is up.',
			name: 'HealthStatus',
			data: healthStatusSchema,
			paginated: false,
		},
		errors: [],
		reasons: [],
	},
	{
		operationId: 'listContacts',
		method: 'GET',
		path: '/api/v1/contacts',
		tag: 'Contacts',
		summary: 'List contacts, a page at a time.',
		scope: 'contacts:read',
		pathParameters: [],
		queryParameters: [
			PAGE_LIMIT,
			PAGE_CURSOR,
			{
				name: 'search',
				description: 'Filter by a search query; results are relevance-ordered.',
				schema: { type: 'string' },
			},
		],
		idempotent: false,
		request: null,
		success: {
			status: 200,
			description: 'One page of contacts.',
			name: 'Contact',
			data: contactSchema,
			paginated: true,
		},
		errors: [],
		reasons: [],
	},
	{
		operationId: 'createContact',
		method: 'POST',
		path: '/api/v1/contacts',
		tag: 'Contacts',
		summary: 'Create a contact.',
		scope: 'contacts:write',
		pathParameters: [],
		queryParameters: [],
		idempotent: false,
		request: { name: 'CreateContactRequest', schema: createContactRequestSchema },
		success: {
			status: 201,
			description: 'The created contact.',
			name: 'Contact',
			data: contactSchema,
			paginated: false,
		},
		errors: [409, 422],
		reasons: [],
	},
	{
		operationId: 'getContact',
		method: 'GET',
		path: '/api/v1/contacts/{id}',
		tag: 'Contacts',
		summary: 'Get a contact by ID or email address.',
		scope: 'contacts:read',
		pathParameters: [CONTACT_REF],
		queryParameters: [],
		idempotent: false,
		request: null,
		success: {
			status: 200,
			description: 'The contact.',
			name: 'Contact',
			data: contactSchema,
			paginated: false,
		},
		errors: [404],
		reasons: [],
	},
	{
		operationId: 'updateContact',
		method: 'PUT',
		path: '/api/v1/contacts/{id}',
		tag: 'Contacts',
		summary: 'Update a contact. Fields left out keep their value.',
		scope: 'contacts:write',
		pathParameters: [CONTACT_REF],
		queryParameters: [],
		idempotent: false,
		request: { name: 'UpdateContactRequest', schema: updateContactRequestSchema },
		success: {
			status: 200,
			description: 'The updated contact.',
			name: 'Contact',
			data: contactSchema,
			paginated: false,
		},
		errors: [404, 409, 422],
		reasons: [],
	},
	{
		operationId: 'deleteContact',
		method: 'DELETE',
		path: '/api/v1/contacts/{id}',
		tag: 'Contacts',
		summary: 'Delete a contact.',
		scope: 'contacts:write',
		pathParameters: [CONTACT_REF],
		queryParameters: [],
		idempotent: false,
		request: null,
		success: {
			status: 200,
			description: 'The contact was deleted.',
			name: 'DeleteContactResponse',
			data: deleteContactResponseSchema,
			paginated: false,
		},
		errors: [404, 422],
		reasons: [],
	},
	{
		operationId: 'sendEvent',
		method: 'POST',
		path: '/api/v1/events',
		tag: 'Events',
		summary: 'Record an event for a contact and fire the automations it triggers.',
		scope: 'events:write',
		pathParameters: [],
		queryParameters: [],
		idempotent: true,
		request: { name: 'SendEventRequest', schema: sendEventRequestSchema },
		success: {
			status: 201,
			description: 'The event was recorded.',
			name: 'SendEventResponse',
			data: sendEventResponseSchema,
			paginated: false,
		},
		errors: [404, 409, 422],
		reasons: ['idempotency_conflict', 'idempotency_erased'],
	},
	{
		operationId: 'sendTransactional',
		method: 'POST',
		path: '/api/v1/transactional',
		tag: 'Transactional',
		summary: 'Queue a transactional email for one recipient.',
		scope: 'transactional:send',
		pathParameters: [],
		queryParameters: [],
		idempotent: true,
		request: { name: 'SendTransactionalRequest', schema: sendTransactionalRequestSchema },
		success: {
			status: 202,
			description: 'The email was queued.',
			name: 'SendTransactionalResponse',
			data: sendTransactionalResponseSchema,
			paginated: false,
		},
		errors: [404, 409, 422],
		reasons: TRANSACTIONAL_REFUSAL_REASONS,
	},
	{
		operationId: 'listTransactionalSends',
		method: 'GET',
		path: '/api/v1/transactional',
		tag: 'Transactional',
		summary: `List the transactional sends, newest first, each with its delivery status, filtered by recipient or by status, within a window of at most ${SEND_LIST_MAX_WINDOW_DAYS} days. Needs the same scope as sending.`,
		scope: 'transactional:send',
		pathParameters: [],
		queryParameters: [PAGE_LIMIT, PAGE_CURSOR, ...SEND_LIST_FILTERS],
		idempotent: false,
		request: null,
		success: {
			status: 200,
			description: 'One page of sends, newest first.',
			name: 'TransactionalSendStatus',
			data: transactionalSendStatusSchema,
			paginated: 'cursor',
		},
		errors: [],
		reasons: ['feature_disabled'],
	},
	{
		operationId: 'getTransactionalSend',
		method: 'GET',
		path: '/api/v1/transactional/{sendId}',
		tag: 'Transactional',
		summary: 'Get the delivery status of one transactional send. Needs the same scope as sending.',
		scope: 'transactional:send',
		pathParameters: [SEND_ID],
		queryParameters: [],
		idempotent: false,
		request: null,
		success: {
			status: 200,
			description: 'Where the send stands.',
			name: 'TransactionalSendStatus',
			data: transactionalSendStatusSchema,
			paginated: false,
		},
		errors: [404],
		reasons: ['feature_disabled'],
	},
	{
		operationId: 'listTopics',
		method: 'GET',
		path: '/api/v1/topics',
		tag: 'Topics',
		summary:
			'List the topics contacts can be subscribed to, a page at a time, oldest first, with the ID the membership routes take.',
		scope: 'topics:read',
		pathParameters: [],
		queryParameters: [PAGE_LIMIT, PAGE_CURSOR],
		idempotent: false,
		request: null,
		success: {
			status: 200,
			description: 'One page of topics.',
			name: 'Topic',
			data: topicSchema,
			paginated: true,
		},
		errors: [],
		reasons: [],
	},
	{
		operationId: 'addContactToTopic',
		method: 'POST',
		path: '/api/v1/topics/{topicId}/contacts',
		tag: 'Topics',
		summary: 'Subscribe a contact to a topic, starting double opt-in when the topic needs it.',
		scope: 'topics:write',
		pathParameters: [TOPIC_ID],
		queryParameters: [],
		idempotent: false,
		request: { name: 'AddContactToTopicRequest', schema: addContactToTopicRequestSchema },
		success: {
			status: 201,
			description: 'The contact is subscribed, or awaiting confirmation.',
			name: 'AddToTopicResponse',
			data: addToTopicResponseSchema,
			paginated: false,
		},
		errors: [404, 422],
		reasons: [],
	},
	{
		operationId: 'removeContactFromTopic',
		method: 'DELETE',
		path: '/api/v1/topics/{topicId}/contacts/{emailOrId}',
		tag: 'Topics',
		summary: 'Unsubscribe a contact from a topic.',
		scope: 'topics:write',
		pathParameters: [
			TOPIC_ID,
			{
				name: 'emailOrId',
				description: 'The contact ID, or the contact email address (URL-encoded).',
			},
		],
		queryParameters: [],
		idempotent: false,
		request: null,
		success: {
			status: 200,
			description: 'The contact is no longer subscribed.',
			name: 'RemoveFromTopicResponse',
			data: removeFromTopicResponseSchema,
			paginated: false,
		},
		errors: [404, 422],
		reasons: [],
	},
	{
		operationId: 'getStatus',
		method: 'GET',
		path: '/api/v1/status',
		tag: 'Status',
		summary:
			'Whether the instance can send: the worst problem with its fix, each sending domain, the bounce and complaint rates and a suspension in force.',
		scope: 'status:read',
		pathParameters: [],
		queryParameters: [],
		idempotent: false,
		request: null,
		success: {
			status: 200,
			description: 'How sending stands.',
			name: 'DeliveryStatus',
			data: deliveryStatusSchema,
			paginated: false,
		},
		errors: [],
		reasons: [],
	},
	{
		operationId: 'listDomains',
		method: 'GET',
		path: '/api/v1/domains',
		tag: 'Domains',
		summary:
			'List the sending domains, each with its verification state and every DNS record it needs: the name, the value to publish and what the last check found. Needs the same scope as the status.',
		scope: 'status:read',
		pathParameters: [],
		queryParameters: [],
		idempotent: false,
		request: null,
		success: {
			status: 200,
			description: 'Every sending domain.',
			name: 'SendingDomainSetupList',
			data: sendingDomainSetupListSchema,
			paginated: false,
		},
		errors: [],
		reasons: [],
	},
] as const satisfies readonly PublicOperation[];

export type PublicOperationId = (typeof PUBLIC_OPERATIONS)[number]['operationId'];

/** The schema of an operation's whole success body, envelope included. */
export function successBodySchema(operation: PublicOperation): z.ZodType {
	const { paginated, data } = operation.success;
	if (paginated === 'cursor') return cursorPaginatedEnvelope(data);
	return paginated ? paginatedEnvelope(data) : dataEnvelope(data);
}

/** The operation with this ID. */
export function publicOperation(operationId: PublicOperationId): PublicOperation {
	return PUBLIC_OPERATIONS.find((operation) => operation.operationId === operationId)!;
}

/** The `error.data.reason` codes an operation can answer with at `status`. */
export function reasonsAt(operation: PublicOperation, status: number): ApiErrorReason[] {
	const reasons = [
		...(operation.scope === null ? [] : API_KEY_ERROR_REASONS),
		...operation.reasons,
	];
	return reasons.filter((reason) => ERROR_REASON_STATUS[reason] === status);
}
