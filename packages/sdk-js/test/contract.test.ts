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
import { NotFoundError } from '../src';
import { createTestClient, mockFetch } from './helpers';

afterEach(() => {
	vi.restoreAllMocks();
});

const CONTACT_ID = 'k57c0ntact00000000000000000000';
const TOPIC_ID = 'k57t0pic0000000000000000000000';
const SEND_ID = 'k57s3nd00000000000000000000000';
const BLOCK_ID = 'k57bl0ck000000000000000000000';

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
	listTransactionalSends: {
		call: (client) => client.transactional.list({ email: 'ada@example.com' }),
		path: '/api/v1/transactional',
		result: example('listTransactionalSends').response,
	},
	getTransactionalSend: {
		call: (client) => client.transactional.get(SEND_ID),
		path: `/api/v1/transactional/${SEND_ID}`,
		result: example('getTransactionalSend').response.data,
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
	listTopics: {
		call: (client) => client.topics.list(),
		path: '/api/v1/topics',
		result: example('listTopics').response,
	},
	listDomains: {
		call: (client) => client.domains.list(),
		path: '/api/v1/domains',
		result: example('listDomains').response.data,
	},
	verifyDomain: {
		call: (client) => client.domains.verify('news.example.com'),
		path: '/api/v1/domains/news.example.com/verify',
		result: example('verifyDomain').response.data,
	},
	getLimits: {
		call: (client) => client.limits.get({ email: 'ada@example.com', slug: 'password-reset' }),
		path: '/api/v1/limits',
		result: example('getLimits').response.data,
	},
	listTransactionalEmails: {
		call: (client) => client.transactionalEmails.list(),
		path: '/api/v1/transactional-emails',
		result: example('listTransactionalEmails').response,
	},
	createTransactionalEmail: {
		call: (client) =>
			client.transactionalEmails.create(example('createTransactionalEmail').request),
		path: '/api/v1/transactional-emails',
		result: example('createTransactionalEmail').response.data,
	},
	getTransactionalEmail: {
		call: (client) => client.transactionalEmails.get('order-confirmation'),
		path: '/api/v1/transactional-emails/order-confirmation',
		result: example('getTransactionalEmail').response.data,
	},
	putTransactionalEmail: {
		call: (client) =>
			client.transactionalEmails.upsert(
				'order-confirmation',
				example('putTransactionalEmail').request
			),
		path: '/api/v1/transactional-emails/order-confirmation',
		result: example('putTransactionalEmail').response.data,
	},
	publishTransactionalEmail: {
		call: (client) => client.transactionalEmails.publish('order-confirmation'),
		path: '/api/v1/transactional-emails/order-confirmation/publish',
		result: example('publishTransactionalEmail').response.data,
	},
	unpublishTransactionalEmail: {
		call: (client) => client.transactionalEmails.unpublish('order-confirmation'),
		path: '/api/v1/transactional-emails/order-confirmation/unpublish',
		result: example('unpublishTransactionalEmail').response.data,
	},
	listSavedBlocks: {
		call: (client) => client.savedBlocks.list(),
		path: '/api/v1/saved-blocks',
		result: example('listSavedBlocks').response,
	},
	createSavedBlock: {
		call: (client) => client.savedBlocks.create(example('createSavedBlock').request),
		path: '/api/v1/saved-blocks',
		result: example('createSavedBlock').response.data,
	},
	getSavedBlock: {
		call: (client) => client.savedBlocks.get(BLOCK_ID),
		path: `/api/v1/saved-blocks/${BLOCK_ID}`,
		result: example('getSavedBlock').response.data,
	},
	updateSavedBlock: {
		call: (client) => client.savedBlocks.update(BLOCK_ID, example('updateSavedBlock').request),
		path: `/api/v1/saved-blocks/${BLOCK_ID}`,
		result: example('updateSavedBlock').response.data,
	},
	dryRunTransactional: {
		call: (client) => client.transactional.dryRun(example('dryRunTransactional').request),
		path: '/api/v1/transactional/dry-run',
		result: example('dryRunTransactional').response.data,
	},
	renderEmail: {
		call: (client) => client.render.email(example('renderEmail').request),
		path: '/api/v1/render',
		result: example('renderEmail').response.data,
	},
	getStatus: {
		call: (client) => client.status.get(),
		path: '/api/v1/status',
		result: example('getStatus').response.data,
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

	it('a dry run against a server without the route fails with the 404, which sent nothing', async () => {
		// What a Convex router answers for a path it does not have.
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response('No matching routes found', { status: 404 })
		);
		const failure = createTestClient().transactional.dryRun(example('dryRunTransactional').request);
		await expect(failure).rejects.toBeInstanceOf(NotFoundError);
		await expect(failure).rejects.toThrow(/does not support dry runs/);
	});

	it('send() refuses a dryRun parameter before anything goes on the wire', async () => {
		const spy = mockFetch({ status: 202, body: example('sendTransactional').response });
		const params = { ...example('sendTransactional').request, dryRun: true };
		await expect(createTestClient().transactional.send(params)).rejects.toMatchObject({
			code: 'invalid_input',
		});
		expect(spy).not.toHaveBeenCalled();
	});

	it('a dry run of an unknown template keeps the server’s own 404', async () => {
		mockFetch({
			status: 404,
			body: {
				error: {
					category: 'not_found',
					message: 'Transactional email with slug "nope" not found',
					data: { reason: 'template_not_found' },
				},
			},
		});
		await expect(
			createTestClient().transactional.dryRun({ email: 'ada@example.com', slug: 'nope' })
		).rejects.toMatchObject({
			reason: 'template_not_found',
			message: expect.stringContaining('nope'),
		});
	});

	it('sends the send list filters under the names the contract documents', async () => {
		const sent = new Set<string>();
		for (const params of [
			{
				email: 'ada@example.com',
				since: '2026-11-01T00:00:00.000Z',
				until: '2026-11-02T00:00:00.000Z',
				limit: 10,
				cursor: 'c1',
			},
			{ status: 'failed' as const },
		]) {
			const spy = mockFetch({ body: example('listTransactionalSends').response });
			await createTestClient().transactional.list(params);
			for (const name of new URL(String(spy.mock.calls[0]![0])).searchParams.keys()) sent.add(name);
			spy.mockRestore();
		}
		const documented = publicOperation('listTransactionalSends').queryParameters.map((p) => p.name);
		expect([...sent].sort()).toEqual([...documented].sort());
	});

	it('sends list query parameters under the names the contract documents', async () => {
		const spy = mockFetch({ body: example('listContacts').response });
		await createTestClient().contacts.list({ limit: 10, cursor: 'c1', search: 'ada' });
		const sent = new URL(String(spy.mock.calls[0]![0]));
		const documented = publicOperation('listContacts').queryParameters.map((p) => p.name);
		expect([...sent.searchParams.keys()].sort()).toEqual([...documented].sort());
	});
});
