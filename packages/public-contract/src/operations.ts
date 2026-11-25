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
	healthStatusSchema,
	paginatedEnvelope,
} from './common';
import {
	contactSchema,
	createContactRequestSchema,
	deleteContactResponseSchema,
	updateContactRequestSchema,
} from './contacts';
import { domainCheckRequestSchema, sendingDomainSetupListSchema } from './domains';
import { sendEventRequestSchema, sendEventResponseSchema } from './events';
import { sendLimitsSchema } from './limits';
import { TEMPLATE_OPERATIONS } from './templateOperations';
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
import { sendTransactionalDryRunSchema } from './render';
import { ERROR_REASON_STATUS } from './errors';
import {
	API_KEY_ERROR_REASONS,
	DOMAIN_CHECK_REFUSAL_REASONS,
	RENDER_REFUSAL_REASONS,
	SEND_LIST_MAX_WINDOW_DAYS,
	TRANSACTIONAL_REFUSAL_REASONS,
	WRITE_REFUSAL_REASONS,
	type ApiErrorReason,
} from './types';
import {
	ANY_KEY,
	CONTACT_REF,
	LIMITS_RECIPIENT_QUERY,
	PAGE_CURSOR,
	PAGE_LIMIT,
	SEND_ID,
	SEND_LIST_FILTERS,
	TOPIC_ID,
	type PublicOperation,
} from './operationShape';

export {
	ANY_KEY,
	KEYED_ERROR_STATUSES,
	type HttpMethod,
	type PathParameter,
	type PublicApiScope,
	type PublicOperation,
	type QueryParameter,
} from './operationShape';

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
		reasons: WRITE_REFUSAL_REASONS,
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
		reasons: WRITE_REFUSAL_REASONS,
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
		reasons: WRITE_REFUSAL_REASONS,
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
		reasons: ['idempotency_conflict', 'idempotency_erased', ...WRITE_REFUSAL_REASONS],
	},
	{
		operationId: 'sendTransactional',
		method: 'POST',
		path: '/api/v1/transactional',
		tag: 'Transactional',
		summary:
			'Queue a transactional email for one recipient. With dryRun: true, compose it and answer what the send would do, without sending.',
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
		dryRun: {
			status: 200,
			description:
				'With dryRun: true, the email a send would compose and the refusal it would meet. Nothing was sent, stored or counted, and no Idempotency-Key was used.',
			name: 'SendTransactionalDryRun',
			data: sendTransactionalDryRunSchema,
		},
		errors: [404, 409, 422],
		reasons: [
			...TRANSACTIONAL_REFUSAL_REASONS,
			...WRITE_REFUSAL_REASONS,
			...RENDER_REFUSAL_REASONS,
		],
	},
	{
		operationId: 'listTransactionalSends',
		method: 'GET',
		path: '/api/v1/transactional',
		tag: 'Transactional',
		summary: `List the transactional sends, newest first, each with its delivery status, filtered by recipient, by status or both, within a window of at most ${SEND_LIST_MAX_WINDOW_DAYS} days. Needs the same scope as sending.`,
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
	...TEMPLATE_OPERATIONS,
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
		reasons: WRITE_REFUSAL_REASONS,
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
		reasons: WRITE_REFUSAL_REASONS,
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
	{
		operationId: 'verifyDomain',
		method: 'POST',
		path: '/api/v1/domains/{domain}/verify',
		tag: 'Domains',
		summary:
			'Ask for a fresh DNS check of one sending domain, at most once a minute per domain. The check runs in the background: poll `GET /api/v1/domains` until `lastCheckedAt` is at or after `requestedAt`.',
		scope: 'domains:verify',
		pathParameters: [
			{
				name: 'domain',
				description: 'The domain name, or its `id` from `GET /api/v1/domains`.',
			},
		],
		queryParameters: [],
		idempotent: false,
		request: null,
		success: {
			status: 202,
			description: 'The check is queued.',
			name: 'DomainCheckRequest',
			data: domainCheckRequestSchema,
			paginated: false,
		},
		errors: [404, 409, 422],
		reasons: [...DOMAIN_CHECK_REFUSAL_REASONS, ...WRITE_REFUSAL_REASONS],
	},
	{
		operationId: 'getLimits',
		method: 'GET',
		path: '/api/v1/limits',
		tag: 'Transactional',
		summary:
			"Read the transactional send limits that apply to this key, and what is left of the key's daily limit until it resets. Any key may read its own. With `email` and a template, also what is left of the per-recipient limit for that pair, which needs the same scope as sending.",
		scope: ANY_KEY,
		pathParameters: [],
		queryParameters: LIMITS_RECIPIENT_QUERY,
		idempotent: false,
		request: null,
		success: {
			status: 200,
			description: 'The limits in force.',
			name: 'SendLimits',
			data: sendLimitsSchema,
			paginated: false,
		},
		// The 403 and 404 belong to the per-recipient count alone.
		errors: [403, 404],
		reasons: ['missing_scope', 'feature_disabled', 'template_not_found'],
	},
] as const satisfies readonly PublicOperation[];

export type PublicOperationId = (typeof PUBLIC_OPERATIONS)[number]['operationId'];

/** The schema of an operation's whole success body, envelope included. */
export function successBodySchema(operation: PublicOperation): z.ZodType {
	const { paginated, data } = operation.success;
	if (paginated === 'cursor') return cursorPaginatedEnvelope(data);
	return paginated ? paginatedEnvelope(data) : dataEnvelope(data);
}

/** The `{ data }` body of an operation's dry-run answer, or `null` when it takes no dry run. */
export function dryRunBodySchema(operation: PublicOperation): z.ZodType | null {
	return operation.dryRun ? dataEnvelope(operation.dryRun.data) : null;
}

/** The operation with this ID. */
export function publicOperation(operationId: PublicOperationId): PublicOperation {
	return PUBLIC_OPERATIONS.find((operation) => operation.operationId === operationId)!;
}

/** The `error.data.reason` codes an operation can answer with at `status`. */
export function reasonsAt(operation: PublicOperation, status: number): ApiErrorReason[] {
	const keyReasons =
		operation.scope === ANY_KEY
			? API_KEY_ERROR_REASONS.filter((reason) => reason !== 'missing_scope')
			: API_KEY_ERROR_REASONS;
	const reasons = [...(operation.scope === null ? [] : keyReasons), ...operation.reasons];
	return reasons.filter((reason) => ERROR_REASON_STATUS[reason] === status);
}
