import { describe, expect, it } from 'vitest';
import { readListQuery } from '../common';
import { createContactRequestSchema, updateContactRequestSchema } from '../contacts';
import { decodeRequest } from '../decode';
import { sendEventRequestSchema } from '../events';
import { OPERATION_EXAMPLES } from '../examples';
import { PUBLIC_OPERATIONS } from '../operations';
import { addContactToTopicRequestSchema } from '../topics';
import { sendTransactionalRequestSchema } from '../transactional';

const message = (schema: Parameters<typeof decodeRequest>[0], input: unknown) => {
	const result = decodeRequest(schema, input);
	return result.ok ? null : result.message;
};

describe('decodeRequest', () => {
	it('hands back the object as sent, unknown fields and key order included', () => {
		const body = { slug: 'welcome', extra: { kept: true }, email: 'ada@example.com' };
		const result = decodeRequest(sendTransactionalRequestSchema, body);
		expect(result.ok && result.value).toBe(body);
		expect(Object.keys(body)).toEqual(['slug', 'extra', 'email']);
	});

	it('accepts every request example', () => {
		for (const operation of PUBLIC_OPERATIONS) {
			if (!operation.request) continue;
			const example = OPERATION_EXAMPLES[operation.operationId] as { request?: unknown };
			expect(example.request, operation.operationId).toBeDefined();
			expect(
				decodeRequest(operation.request.schema, example.request).ok,
				operation.operationId
			).toBe(true);
		}
	});

	it.each([null, [], 'text', 42, true])('refuses a non-object body (%j)', (body) => {
		for (const operation of PUBLIC_OPERATIONS) {
			if (!operation.request) continue;
			expect(message(operation.request.schema, body)).toBe('Request body must be a JSON object');
		}
	});

	it('answers with the documented message, never a generic one', () => {
		const junk: unknown[] = [null, 0, 1, '', 'x', true, false, [], [1], {}, { a: { b: 1 } }];
		for (const operation of PUBLIC_OPERATIONS) {
			if (!operation.request) continue;
			const example = (OPERATION_EXAMPLES[operation.operationId] as { request: object }).request;
			const shape = Object.keys(
				(operation.request.schema as unknown as { shape: Record<string, unknown> }).shape
			);
			for (const field of shape) {
				for (const value of junk) {
					const text = message(operation.request.schema, { ...example, [field]: value });
					if (text === null) continue;
					expect(text, `${operation.operationId}.${field}=${JSON.stringify(value)}`).not.toMatch(
						/^(Invalid input|Invalid option|Too (big|small)|Expected|Invalid string)/
					);
				}
			}
		}
	});
});

describe('transactional request', () => {
	const base = { email: 'ada@example.com', slug: 'welcome' };

	it.each([
		[{ slug: 'welcome' }, 'email is required'],
		[{ ...base, email: '' }, 'email is required'],
		[{ ...base, email: null }, 'email is required'],
		[{ ...base, email: 5 }, 'email must be a string'],
		[{ email: 'ada@example.com' }, 'Either transactionalId or slug is required'],
		[
			{ email: 'ada@example.com', slug: '', transactionalId: null },
			'Either transactionalId or slug is required',
		],
		[{ ...base, transactionalId: 7 }, 'transactionalId must be a string'],
		[
			{ ...base, dataVariables: { order: { id: 1 } } },
			'dataVariables must be an object of string, number, boolean or null values',
		],
		[
			{ ...base, dataVariables: { tags: ['a'] } },
			'dataVariables must be an object of string, number, boolean or null values',
		],
		[
			{ ...base, dataVariables: ['a'] },
			'dataVariables must be an object of string, number, boolean or null values',
		],
		[{ ...base, language: null }, 'language must be a string'],
		[
			{ ...base, language: 'english' },
			"language must be a valid language code (e.g., 'en', 'de', 'fr', 'en-US')",
		],
		[
			{ ...base, language: 'zh-Hant' },
			"language must be a valid language code (e.g., 'en', 'de', 'fr', 'en-US')",
		],
		[{ ...base, attachments: {} }, 'attachments must be an array'],
		[
			{
				...base,
				attachments: Array.from({ length: 11 }, () => ({ filename: 'a', url: 'https://x' })),
			},
			'Maximum 10 attachments allowed',
		],
		[{ ...base, attachments: ['x'] }, 'attachments[0] must be an object'],
		[
			{ ...base, attachments: [{ filename: 'a', url: 'https://x' }, { url: 'https://x' }] },
			'attachments[1].filename is required and must be a string',
		],
		[
			{ ...base, attachments: [{ filename: 'a/b', url: 'https://x' }] },
			'attachments[0].filename must not contain path separators',
		],
		[
			{ ...base, attachments: [{ filename: 'a\\b', url: 'https://x' }] },
			'attachments[0].filename must not contain path separators',
		],
		[
			{ ...base, attachments: [{ filename: 'a' }] },
			'attachments[0] must have exactly one of "content" (base64) or "url"',
		],
		[
			{ ...base, attachments: [{ filename: 'a', content: 'AA==', url: 'https://x' }] },
			'attachments[0] must have exactly one of "content" (base64) or "url"',
		],
		[
			{ ...base, attachments: [{ filename: 'a', url: 5 }] },
			'attachments[0].url must be an HTTPS URL',
		],
		[
			{ ...base, attachments: [{ filename: 'a', content: 5 }] },
			'attachments[0].content must be a base64-encoded string',
		],
	])('%j → %s', (body, expected) => {
		expect(message(sendTransactionalRequestSchema, body)).toBe(expected);
	});

	it.each([
		{ ...base, language: '' },
		{ ...base, language: 'EN' },
		{ ...base, language: 'pt-BR' },
		{ ...base, language: 'en-gb' },
		{ email: 'ada@example.com', transactionalId: 'tmpl', slug: null },
		{ email: 'ada@example.com', transactionalId: null, slug: 'welcome' },
		{ ...base, dataVariables: {} },
		{ ...base, attachments: [] },
		{ ...base, attachments: [{ filename: 'a.txt', content: '' }] },
	])('accepts %j', (body) => {
		expect(message(sendTransactionalRequestSchema, body)).toBeNull();
	});
});

describe('event request', () => {
	const base = { email: 'ada@example.com', eventName: 'signed_up' };

	it.each([
		[{ eventName: 'x' }, 'email is required'],
		[{ ...base, email: [] }, 'email must be a string'],
		[{ email: 'ada@example.com' }, 'eventName is required'],
		[{ ...base, eventName: '' }, 'eventName is required'],
		[{ ...base, eventName: 3 }, 'eventName must be a string'],
		[
			{ ...base, eventName: '1st' },
			'eventName must start with a letter and contain only alphanumeric characters, underscores, or hyphens (max 100 chars)',
		],
		[
			{ ...base, eventName: `a${'b'.repeat(100)}` },
			'eventName must start with a letter and contain only alphanumeric characters, underscores, or hyphens (max 100 chars)',
		],
		[
			{ ...base, eventProperties: { nested: {} } },
			'eventProperties must be an object of string, number, boolean or null values',
		],
		[
			{ ...base, eventProperties: null },
			'eventProperties must be an object of string, number, boolean or null values',
		],
		[{ ...base, createContactIfNotExists: 'yes' }, 'createContactIfNotExists must be a boolean'],
		[{ ...base, createContactIfNotExists: null }, 'createContactIfNotExists must be a boolean'],
	])('%j → %s', (body, expected) => {
		expect(message(sendEventRequestSchema, body)).toBe(expected);
	});

	it('accepts a 100-character name', () => {
		expect(
			message(sendEventRequestSchema, { ...base, eventName: `a${'b'.repeat(99)}` })
		).toBeNull();
	});
});

describe('contact requests', () => {
	it.each([
		[{}, 'Email is required'],
		[{ email: 5 }, 'Email must be a string'],
		[{ email: 'ada@example.com', firstName: 5 }, 'firstName must be a string'],
		[{ email: 'ada@example.com', lastName: null }, 'lastName must be a string'],
	])('create %j → %s', (body, expected) => {
		expect(message(createContactRequestSchema, body)).toBe(expected);
	});

	it.each([
		[{ email: null }, 'email must be a string'],
		[{ firstName: [] }, 'firstName must be a string'],
	])('update %j → %s', (body, expected) => {
		expect(message(updateContactRequestSchema, body)).toBe(expected);
	});

	it('an update may name no field at all', () => {
		expect(message(updateContactRequestSchema, {})).toBeNull();
	});
});

describe('topic membership request', () => {
	it.each([
		[{}, 'Either email or contactId is required'],
		[{ email: '', contactId: null }, 'Either email or contactId is required'],
		[{ email: 5 }, 'email must be a string'],
		[{ contactId: {} }, 'contactId must be a string'],
	])('%j → %s', (body, expected) => {
		expect(message(addContactToTopicRequestSchema, body)).toBe(expected);
	});

	it('a null reference beside a real one is accepted', () => {
		expect(
			message(addContactToTopicRequestSchema, { email: null, contactId: 'k5700000000' })
		).toBeNull();
	});
});

describe('readListQuery', () => {
	const read = (query: string) => readListQuery(new URLSearchParams(query));

	it.each([
		['', { limit: 25, cursor: null }],
		['limit=', { limit: 25, cursor: null }],
		['limit=10&cursor=abc&search=ada', { limit: 10, cursor: 'abc', search: 'ada' }],
		['limit=500', { limit: 100, cursor: null }],
		['limit=7abc', { limit: 7, cursor: null }],
		['search=', { limit: 25, cursor: null }],
	])('%s', (query, value) => {
		expect(read(query)).toEqual({ ok: true, value });
	});

	it.each(['limit=0', 'limit=-3', 'limit=abc'])('%s is refused', (query) => {
		expect(read(query)).toEqual({ ok: false, message: 'Invalid limit' });
	});
});
