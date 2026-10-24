import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contactSchema } from '../contacts';
import { decodeRequest } from '../decode';
import { OPERATION_EXAMPLES } from '../examples';
import { buildOpenApiDocument } from '../openapi';
import { PUBLIC_OPERATIONS, publicOperation, successBodySchema } from '../operations';
import { addContactToTopicRequestSchema } from '../topics';
import { sendTransactionalRequestSchema } from '../transactional';

const committed = JSON.parse(
	readFileSync(new URL('../../openapi.json', import.meta.url), 'utf8')
) as Record<string, unknown>;

type Paths = Record<string, Record<string, { operationId: string }>>;

describe('openapi.json', () => {
	it('is what the contract generates', () => {
		expect(committed).toEqual(buildOpenApiDocument());
	});

	it('is the same document on every build', () => {
		expect(JSON.stringify(buildOpenApiDocument())).toBe(JSON.stringify(buildOpenApiDocument()));
	});

	it('lists every operation once, under its method and path', () => {
		const paths = committed['paths'] as Paths;
		const listed = Object.entries(paths).flatMap(([path, methods]) =>
			Object.entries(methods).map(
				([method, op]) => `${method.toUpperCase()} ${path} ${op.operationId}`
			)
		);
		expect(listed.sort()).toEqual(
			PUBLIC_OPERATIONS.map((op) => `${op.method} ${op.path} ${op.operationId}`).sort()
		);
	});

	it('names every path parameter its path holds', () => {
		for (const operation of PUBLIC_OPERATIONS) {
			const placeholders = [...operation.path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
			expect(operation.pathParameters.map((p) => p.name)).toEqual(placeholders);
		}
	});

	it('changes when a required field is dropped', () => {
		const contact = publicOperation('getContact');
		const altered = buildOpenApiDocument(
			PUBLIC_OPERATIONS.map((operation) =>
				operation === contact
					? {
							...operation,
							success: {
								...operation.success,
								data: contactSchema.partial({ email: true }),
							},
						}
					: operation
			)
		);
		expect(altered).not.toEqual(committed);
	});
});

describe('examples', () => {
	it('every success example is a valid response body', () => {
		for (const operation of PUBLIC_OPERATIONS) {
			const result = successBodySchema(operation).safeParse(
				OPERATION_EXAMPLES[operation.operationId].response
			);
			expect(result.error?.issues, operation.operationId).toBeUndefined();
		}
	});

	it('a response with an undocumented field is not a valid body', () => {
		const operation = publicOperation('getContact');
		const body = { data: { ...OPERATION_EXAMPLES.getContact.response.data, phone: '+1' } };
		expect(successBodySchema(operation).safeParse(body).success).toBe(false);
	});
});

type JsonSchema = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const TYPE_OF: Record<string, (value: unknown) => boolean> = {
	string: (value) => typeof value === 'string',
	null: (value) => value === null,
	object: isObject,
};

function hasType(type: string, value: unknown): boolean {
	const test = TYPE_OF[type];
	if (!test) throw new Error(`conforms() does not know the type ${type}`);
	return test(value);
}

/**
 * Whether `value` satisfies `schema`, for the keywords the reference rules
 * use. Any other keyword it meets throws, so a test body that reaches a rule
 * this check does not know fails instead of passing unchecked.
 */
function conforms(schema: JsonSchema, value: unknown): boolean {
	for (const [keyword, rule] of Object.entries(schema)) {
		switch (keyword) {
			case 'type': {
				const types = Array.isArray(rule) ? (rule as string[]) : [rule as string];
				if (!types.some((type) => hasType(type, value))) return false;
				break;
			}
			case 'minLength':
				if (typeof value === 'string' && [...value].length < (rule as number)) return false;
				break;
			case 'required':
				if (isObject(value) && !(rule as string[]).every((field) => Object.hasOwn(value, field)))
					return false;
				break;
			case 'properties':
				if (!isObject(value)) break;
				for (const [field, inner] of Object.entries(rule as Record<string, JsonSchema>)) {
					if (Object.hasOwn(value, field) && !conforms(inner, value[field])) return false;
				}
				break;
			case 'anyOf':
				if (!(rule as JsonSchema[]).some((branch) => conforms(branch, value))) return false;
				break;
			default:
				throw new Error(`conforms() does not know the keyword ${keyword}`);
		}
	}
	return true;
}

describe('request references', () => {
	const components = (committed['components'] as { schemas: Record<string, JsonSchema> }).schemas;

	it.each([
		[
			'SendTransactionalRequest',
			sendTransactionalRequestSchema,
			'transactionalId',
			'slug',
			{ email: 'ada@example.com' },
		],
		['AddContactToTopicRequest', addContactToTopicRequestSchema, 'email', 'contactId', {}],
	] as const)(
		'%s: the document and the decoder agree on which references name a target',
		(name, schema, first, second, base) => {
			const values: unknown[] = [undefined, null, '', 'k57ref', 7];
			for (const a of values) {
				for (const b of values) {
					const body: Record<string, unknown> = { ...base };
					if (a !== undefined) body[first] = a;
					if (b !== undefined) body[second] = b;
					expect(conforms(components[name]!, body), JSON.stringify(body)).toBe(
						decodeRequest(schema, body).ok
					);
				}
			}
		}
	);
});
