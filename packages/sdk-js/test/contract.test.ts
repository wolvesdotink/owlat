/**
 * Every SDK call against the public API contract: the call hits the
 * operation's method and path, its body is a request the server's own decoder
 * accepts, and the operation's example response comes back as the result.
 * An operation the SDK does not cover fails the coverage check below.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	decodeRequest,
	OPERATION_EXAMPLES,
	PUBLIC_OPERATIONS,
	publicOperation,
	type PublicOperationId,
} from '@owlat/public-contract/schemas';
import type { Owlat } from '../src';
import { createTestClient, mockFetch } from './helpers';

afterEach(() => {
	vi.restoreAllMocks();
});

const CONTACT_ID = 'k57c0ntact00000000000000000000';
const TOPIC_ID = 'k57t0pic0000000000000000000000';

const example = <Id extends PublicOperationId>(id: Id) => OPERATION_EXAMPLES[id];
const requestOf = (id: PublicOperationId) =>
	(OPERATION_EXAMPLES[id] as { request?: Record<string, unknown> }).request;

/**
 * One SDK call per operation, the concrete path it should reach, and what the
 * call should return from the example response.
 */
const CALLS: Record<
	Exclude<PublicOperationId, 'getHealth'>,
	{ call: (client: Owlat) => Promise<unknown>; path: string; result: unknown }
> = {
	listContacts: {
		call: (client) => client.contacts.list(),
		path: '/api/v1/contacts',
		result: example('listContacts').response,
	},
	createContact: {
		call: (client) => client.contacts.create(example('createContact').request),
		path: '/api/v1/contacts',
		result: example('createContact').response.data,
	},
	getContact: {
		call: (client) => client.contacts.get(CONTACT_ID),
		path: `/api/v1/contacts/${CONTACT_ID}`,
		result: example('getContact').response.data,
	},
	updateContact: {
		call: (client) => client.contacts.update('ada@example.com', example('updateContact').request),
		path: '/api/v1/contacts/ada%40example.com',
		result: example('updateContact').response.data,
	},
	deleteContact: {
		call: (client) => client.contacts.delete(CONTACT_ID),
		path: `/api/v1/contacts/${CONTACT_ID}`,
		result: example('deleteContact').response.data,
	},
	sendEvent: {
		call: (client) => client.events.send(example('sendEvent').request),
		path: '/api/v1/events',
		result: example('sendEvent').response.data,
	},
	sendTransactional: {
		call: (client) => client.transactional.send(example('sendTransactional').request),
		path: '/api/v1/transactional',
		result: example('sendTransactional').response.data,
	},
	addContactToTopic: {
		call: (client) =>
			client.topics.addContact({ topicId: TOPIC_ID, ...example('addContactToTopic').request }),
		path: `/api/v1/topics/${TOPIC_ID}/contacts`,
		result: example('addContactToTopic').response.data,
	},
	removeContactFromTopic: {
		call: (client) =>
			client.topics.removeContact({ topicId: TOPIC_ID, emailOrId: 'ada@example.com' }),
		path: `/api/v1/topics/${TOPIC_ID}/contacts/ada%40example.com`,
		result: example('removeContactFromTopic').response.data,
	},
};

/** The path template a concrete path instantiates, e.g. `/a/{id}` for `/a/x`. */
function matchesTemplate(template: string, path: string): boolean {
	const pattern = template.replace(/\{\w+\}/g, '[^/]+');
	return new RegExp(`^${pattern}$`).test(path);
}

describe('SDK calls against the public contract', () => {
	it('covers every keyed operation', () => {
		expect(Object.keys(CALLS).sort()).toEqual(
			PUBLIC_OPERATIONS.filter((op) => op.scope !== null)
				.map((op) => op.operationId)
				.sort()
		);
	});

	it.each(Object.entries(CALLS))('%s', async (id, { call, path, result }) => {
		const operation = publicOperation(id as PublicOperationId);
		const spy = mockFetch({
			status: operation.success.status,
			body: example(operation.operationId).response,
		});

		await expect(call(createTestClient())).resolves.toEqual(result);

		const [url, init] = spy.mock.calls[0]!;
		const sent = new URL(String(url));
		expect(init?.method).toBe(operation.method);
		expect(sent.pathname).toBe(path);
		expect(matchesTemplate(operation.path, sent.pathname)).toBe(true);

		const request = requestOf(operation.operationId);
		if (operation.request) {
			const body: unknown = JSON.parse(String(init?.body));
			expect(decodeRequest(operation.request.schema, body)).toEqual({ ok: true, value: body });
			expect(body).toEqual(request);
		} else {
			expect(init?.body ?? undefined).toBeUndefined();
		}
	});

	it('sends list query parameters under the names the contract documents', async () => {
		const spy = mockFetch({ body: example('listContacts').response });
		await createTestClient().contacts.list({ limit: 10, cursor: 'c1', search: 'ada' });
		const sent = new URL(String(spy.mock.calls[0]![0]));
		const documented = publicOperation('listContacts').queryParameters.map((p) => p.name);
		expect([...sent.searchParams.keys()].sort()).toEqual([...documented].sort());
	});
});
