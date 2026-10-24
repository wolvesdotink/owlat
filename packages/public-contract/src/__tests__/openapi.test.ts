import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contactSchema } from '../contacts';
import { OPERATION_EXAMPLES } from '../examples';
import { buildOpenApiDocument } from '../openapi';
import { PUBLIC_OPERATIONS, publicOperation, successBodySchema } from '../operations';

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
