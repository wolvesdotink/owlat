/**
 * One example request and success response per operation. They appear in the
 * OpenAPI document, this package's tests parse each against its schema, and
 * the Java SDK's tests read every response example into the SDK's model
 * classes, so each one has to be a body the server really sends.
 *
 * Every field the type allows is filled in, so a field the SDKs cannot read
 * shows up as a failure rather than as an untested omission.
 */

import type { PublicOperationId } from './operations';
import type {
	AddContactToTopicRequest,
	AddToTopicResponse,
	ApiResponse,
	Contact,
	CreateContactRequest,
	DeleteContactResponse,
	HealthStatus,
	PaginatedResponse,
	RemoveFromTopicResponse,
	SendEventRequest,
	SendEventResponse,
	SendTransactionalRequest,
	SendTransactionalResponse,
	UpdateContactRequest,
} from './types';

const CONTACT: Contact = {
	id: 'k57c0ntact00000000000000000000',
	email: 'ada@example.com',
	firstName: 'Ada',
	lastName: null,
	source: 'api',
	createdAt: '2026-01-15T09:30:00.000Z',
	updatedAt: '2026-01-16T10:00:00.000Z',
};

export interface OperationExample {
	request?: unknown;
	response: unknown;
}

export const OPERATION_EXAMPLES = {
	getHealth: {
		response: {
			data: { status: 'ok', timestamp: '2026-01-15T09:30:00.000Z' },
		} satisfies ApiResponse<HealthStatus>,
	},
	listContacts: {
		response: {
			data: [CONTACT, { ...CONTACT, id: 'k57c0ntact00000000000000000001', source: 'inbound' }],
			pagination: { limit: 25, totalItems: 42, cursor: 'eyJwYWdlIjoxfQ', isDone: false },
		} satisfies PaginatedResponse<Contact>,
	},
	createContact: {
		request: {
			email: 'ada@example.com',
			firstName: 'Ada',
			lastName: 'Lovelace',
		} satisfies CreateContactRequest,
		response: { data: CONTACT } satisfies ApiResponse<Contact>,
	},
	getContact: {
		response: { data: CONTACT } satisfies ApiResponse<Contact>,
	},
	updateContact: {
		request: { firstName: 'Ada', lastName: 'Lovelace' } satisfies UpdateContactRequest,
		response: { data: { ...CONTACT, lastName: 'Lovelace' } } satisfies ApiResponse<Contact>,
	},
	deleteContact: {
		response: {
			data: { id: CONTACT.id, deleted: true },
		} satisfies ApiResponse<DeleteContactResponse>,
	},
	sendEvent: {
		request: {
			email: 'ada@example.com',
			eventName: 'signup_completed',
			eventProperties: { plan: 'pro', seats: 3, trial: false, referrer: null },
			createContactIfNotExists: true,
		} satisfies SendEventRequest,
		response: {
			data: {
				eventId: 'k57ev3nt000000000000000000000',
				contactId: CONTACT.id,
				eventName: 'signup_completed',
				triggeredAutomations: 2,
				contactCreated: false,
			},
		} satisfies ApiResponse<SendEventResponse>,
	},
	sendTransactional: {
		request: {
			email: 'ada@example.com',
			slug: 'order-confirmation',
			dataVariables: { orderNumber: 'A-1001', total: 42.5, giftWrap: true, note: null },
			language: 'en-US',
			attachments: [
				{
					filename: 'invoice.pdf',
					content: 'JVBERi0xLjQK',
					contentType: 'application/pdf',
				},
				{ filename: 'terms.pdf', url: 'https://owlat.example/terms.pdf' },
			],
		} satisfies SendTransactionalRequest,
		response: {
			data: {
				status: 'queued',
				email: 'ada@example.com',
				transactionalEmailId: 'k57s3nd00000000000000000000000',
				slug: 'order-confirmation',
				contactId: CONTACT.id,
				contactCreated: false,
				language: 'en-US',
			},
		} satisfies ApiResponse<SendTransactionalResponse>,
	},
	addContactToTopic: {
		request: { email: 'ada@example.com' } satisfies AddContactToTopicRequest,
		response: {
			data: {
				success: true,
				contactId: CONTACT.id,
				topicId: 'k57t0pic0000000000000000000000',
				doiStatus: 'pending',
			},
		} satisfies ApiResponse<AddToTopicResponse>,
	},
	removeContactFromTopic: {
		response: {
			data: { success: true, removed: true },
		} satisfies ApiResponse<RemoveFromTopicResponse>,
	},
} satisfies Record<PublicOperationId, OperationExample>;
