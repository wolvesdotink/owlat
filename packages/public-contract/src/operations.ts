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
import { sendEventRequestSchema, sendEventResponseSchema } from './events';
import {
	addContactToTopicRequestSchema,
	addToTopicResponseSchema,
	removeFromTopicResponseSchema,
} from './topics';
import { sendTransactionalRequestSchema, sendTransactionalResponseSchema } from './transactional';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** A key scope one operation requires. */
export type PublicApiScope =
	| 'contacts:read'
	| 'contacts:write'
	| 'events:write'
	| 'transactional:send'
	| 'topics:write';

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
	tag: 'Contacts' | 'Events' | 'Transactional' | 'Topics' | 'Health';
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
	 * item, or `{ data: [...], pagination }` when `paginated`. `name` is the
	 * item's name in the document's components.
	 */
	success: {
		status: number;
		description: string;
		name: string;
		data: z.ZodType;
		paginated: boolean;
	};
	/** Error statuses the operation answers with, beyond the ones every keyed call can. */
	errors: readonly number[];
}

/** Statuses every key-authenticated call can answer with. */
export const KEYED_ERROR_STATUSES = [400, 401, 403, 429, 500] as const;

const CONTACT_REF: PathParameter = {
	name: 'id',
	description: 'The contact ID, or the contact email address (URL-encoded).',
};
const TOPIC_ID: PathParameter = { name: 'topicId', description: 'The topic ID.' };

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
			{
				name: 'limit',
				description: `Items per page, at most ${MAX_PAGE_SIZE}; a larger value is clamped.`,
				schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
			},
			{
				name: 'cursor',
				description: "The previous page's `pagination.cursor`. Omit it for the first page.",
				schema: { type: 'string' },
			},
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
		errors: [409],
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
		errors: [404, 409],
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
		errors: [404],
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
		errors: [404, 409],
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
		errors: [404],
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
		errors: [404],
	},
] as const satisfies readonly PublicOperation[];

export type PublicOperationId = (typeof PUBLIC_OPERATIONS)[number]['operationId'];

/** The schema of an operation's whole success body, envelope included. */
export function successBodySchema(operation: PublicOperation): z.ZodType {
	return operation.success.paginated
		? paginatedEnvelope(operation.success.data)
		: dataEnvelope(operation.success.data);
}

/** The operation with this ID. */
export function publicOperation(operationId: PublicOperationId): PublicOperation {
	return PUBLIC_OPERATIONS.find((operation) => operation.operationId === operationId)!;
}
