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
	CursorPaginatedResponse,
	AddToTopicResponse,
	ApiResponse,
	Contact,
	DeliveryStatus,
	DomainCheckRequest,
	CreateContactRequest,
	DeleteContactResponse,
	HealthStatus,
	PaginatedResponse,
	RemoveFromTopicResponse,
	SendEventRequest,
	SendEventResponse,
	SendTransactionalRequest,
	SendTransactionalResponse,
	SendingDomainSetup,
	SendLimits,
	Topic,
	TransactionalSendStatus,
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
	listTransactionalSends: {
		response: {
			data: [
				{
					sendId: 'k57s3nd00000000000000000000001',
					status: 'bounced',
					email: 'ada@example.com',
					templateId: 'k57t3mpl4te0000000000000000000',
					slug: 'password-reset',
					language: 'en',
					queuedAt: '2026-11-21T07:30:00.000Z',
					sentAt: '2026-11-21T07:30:02.000Z',
					deliveredAt: null,
					openedAt: null,
					clickedAt: null,
					bouncedAt: '2026-11-21T07:30:05.000Z',
					complainedAt: null,
					failedAt: null,
					bounceType: 'hard',
					bounceCause: 'recipient',
					errorCode: null,
					errorMessage: '550 5.1.1 The email account that you tried to reach does not exist',
				},
			],
			pagination: { limit: 25, cursor: null, isDone: true },
		} satisfies CursorPaginatedResponse<TransactionalSendStatus>,
	},
	getTransactionalSend: {
		response: {
			data: {
				sendId: 'k57s3nd00000000000000000000000',
				status: 'failed',
				email: 'ada@example.com',
				templateId: 'k57t3mpl4te0000000000000000000',
				slug: 'order-confirmation',
				language: 'en-US',
				queuedAt: '2026-11-02T09:00:00.000Z',
				sentAt: null,
				deliveredAt: null,
				openedAt: null,
				clickedAt: null,
				bouncedAt: null,
				complainedAt: null,
				failedAt: '2026-11-06T09:00:00.000Z',
				bounceType: null,
				bounceCause: null,
				errorCode: 'MTA_UNREACHABLE',
				errorMessage: 'The mail server could not be reached before the delivery deadline passed',
			},
		} satisfies ApiResponse<TransactionalSendStatus>,
	},
	listTopics: {
		response: {
			data: [
				{
					id: 'k57t0pic0000000000000000000000',
					name: 'Product updates',
					description: 'New features and changes, about once a month.',
					requiresDoubleOptIn: true,
					createdAt: '2026-01-10T08:00:00.000Z',
				},
				{
					id: 'k57t0pic0000000000000000000001',
					name: 'Events',
					description: null,
					requiresDoubleOptIn: false,
					createdAt: '2026-02-01T12:00:00.000Z',
				},
			],
			pagination: { limit: 25, totalItems: 2, cursor: null, isDone: true },
		} satisfies PaginatedResponse<Topic>,
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
	getStatus: {
		response: {
			data: {
				level: 'error',
				reasonCode: 'sending_suspended',
				explanation:
					'Sending is suspended on this instance, so new sends are refused and campaigns hold until it lifts; the sending hold says whether it lifts by itself once the rate behind it recovers, and a platform admin of this instance can lift it in the operator console, while transactional mail already queued is still delivered and a campaign held past its delivery deadline stops without mailing the rest.',
				fix: { route: '/dashboard/admin/operator', who: 'platform_admin' },
				domains: [
					{ domain: 'mail.example.com', status: 'verified' },
					{ domain: 'news.example.com', status: 'pending' },
				],
				rates: {
					windowDays: 30,
					sent: 12000,
					bounce: { ratePct: 1.25, limitPct: 2, isOver: false },
					complaint: { ratePct: 0.42, limitPct: 0.1, isOver: true },
				},
				sendingHold: {
					status: 'suspended',
					since: '2026-11-20T09:00:00.000Z',
					detail: 'Auto-suspended: complaint rate 0.42% over the 0.1% limit',
					lift: {
						mode: 'automatic',
						condition: {
							trigger: 'complaint_rate',
							domain: null,
							currentPct: 0.42,
							limitPct: 0.2,
							isClear: false,
							clearsAt: null,
						},
					},
				},
			},
		} satisfies ApiResponse<DeliveryStatus>,
	},
	listDomains: {
		response: {
			data: [
				{
					id: 'k57d0main0000000000000000000000',
					domain: 'news.example.com',
					status: 'failed',
					lastCheckedAt: '2026-11-21T07:30:00.000Z',
					records: [
						{
							purpose: 'dkim',
							type: 'CNAME',
							host: 's1._domainkey.news.example.com',
							value: 's1.dkim.owlat.example',
							priority: null,
							state: 'wrong',
							foundValue: 'old.dkim.example.net',
						},
						{
							purpose: 'dmarc',
							type: 'TXT',
							host: '_dmarc.news.example.com',
							value: 'v=DMARC1; p=none',
							priority: null,
							state: 'missing',
							foundValue: null,
						},
						{
							purpose: 'mail_from',
							type: 'MX',
							host: 'bounce.news.example.com',
							value: 'feedback.owlat.example',
							priority: 10,
							state: 'found',
							foundValue: null,
						},
					],
				},
			],
		} satisfies ApiResponse<SendingDomainSetup[]>,
	},
	verifyDomain: {
		response: {
			data: {
				id: 'k57d0ma1n00000000000000000000',
				domain: 'news.example.com',
				status: 'failed',
				lastCheckedAt: '2026-11-21T07:30:00.000Z',
				requestedAt: '2026-11-23T15:30:00.000Z',
			},
		} satisfies ApiResponse<DomainCheckRequest>,
	},
	getLimits: {
		response: {
			data: {
				dailySends: {
					isEnabled: true,
					limit: 50_000,
					used: 1_204,
					remaining: 48_796,
					resetsAt: '2026-11-24T00:00:00.000Z',
				},
				recipientSends: {
					isEnabled: true,
					limit: 5,
					windowSeconds: 3600,
					usage: {
						email: 'ada@example.com',
						templateId: 'k57t3mpl4te0000000000000000000',
						slug: 'password-reset',
						isExempt: false,
						used: 2,
						remaining: 3,
						resetsAt: '2026-11-23T15:54:00.000Z',
					},
				},
			},
		} satisfies ApiResponse<SendLimits>,
	},
} satisfies Record<PublicOperationId, OperationExample>;
