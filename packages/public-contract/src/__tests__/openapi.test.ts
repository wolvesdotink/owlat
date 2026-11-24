import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contactSchema } from '../contacts';
import { decodeRequest } from '../decode';
import { OPERATION_EXAMPLES } from '../examples';
import { buildOpenApiDocument } from '../openapi';
import { ERROR_REASON_STATUS } from '../errors';
import {
	ANY_KEY,
	KEYED_ERROR_STATUSES,
	PUBLIC_OPERATIONS,
	publicOperation,
	successBodySchema,
} from '../operations';
import { addContactToTopicRequestSchema } from '../topics';
import { sendTransactionalRequestSchema } from '../transactional';
import {
	API_KEY_ERROR_REASONS,
	DELIVERY_STATUS_REASONS,
	DNS_RECORD_PURPOSES,
	DNS_RECORD_STATES,
	DNS_RECORD_TYPES,
	TRANSACTIONAL_REFUSAL_REASONS,
} from '../types';

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

describe('a document an instance serves', () => {
	it('names the instance as its only server and differs from the committed file in nothing else', () => {
		const served = buildOpenApiDocument(PUBLIC_OPERATIONS, {
			serverUrl: 'https://api.owlat.example',
		});
		expect(served['servers']).toEqual([{ url: 'https://api.owlat.example' }]);
		const { servers: _served, ...rest } = served;
		const { servers: _committed, ...committedRest } = committed;
		expect(rest).toEqual(committedRest);
	});

	it('keeps the placeholder server without an address', () => {
		const servers = committed['servers'] as { url: string }[];
		expect(servers.map((server) => server.url)).toEqual(['{baseUrl}']);
	});
});

describe('sending domains', () => {
	it('lists every record state, purpose and type the domain list can name', () => {
		const schemas = (committed['components'] as { schemas: Record<string, any> }).schemas;
		const record = schemas['SendingDomainSetup'].properties.records.items.properties;
		expect(record.state.enum).toEqual([...DNS_RECORD_STATES]);
		expect(record.purpose.enum).toEqual([...DNS_RECORD_PURPOSES]);
		expect(record.type.enum).toEqual([...DNS_RECORD_TYPES]);
		expect(schemas['SendingDomainSetupList']).toEqual({
			type: 'array',
			items: { $ref: '#/components/schemas/SendingDomainSetup' },
		});
	});
});

describe('the limits', () => {
	it('take any key: no scope, and no 403 for a scope the key lacks', () => {
		const limits = (committed['paths'] as Record<string, any>)['/api/v1/limits'].get;
		expect(limits.security).toEqual([{ apiKey: [] }]);
		expect(Object.keys(limits.responses)).toEqual(['200', '400', '401', '429', '500']);
	});
});

describe('the send list', () => {
	it('pages without a total, since counting the matches would read them all', () => {
		const schemas = (committed['components'] as { schemas: Record<string, any> }).schemas;
		const list = (committed['paths'] as Record<string, any>)['/api/v1/transactional'].get;
		const body = list.responses['200'].content['application/json'].schema;
		expect(body.properties).toEqual({
			data: { type: 'array', items: { $ref: '#/components/schemas/TransactionalSendStatus' } },
			pagination: { $ref: '#/components/schemas/CursorPaginationMeta' },
		});
		expect(Object.keys(schemas['CursorPaginationMeta'].properties)).toEqual([
			'limit',
			'cursor',
			'isDone',
		]);
		expect(list.parameters.map((parameter: { name: string }) => parameter.name)).toEqual([
			'limit',
			'cursor',
			'email',
			'status',
			'since',
			'until',
		]);
	});
});

describe('delivery status', () => {
	it('lists every reason code the status can name, and only those', () => {
		const schemas = (committed['components'] as { schemas: Record<string, any> }).schemas;
		expect(schemas['DeliveryStatus'].properties.reasonCode.enum).toEqual([
			...DELIVERY_STATUS_REASONS,
		]);
	});
});

describe('error reasons', () => {
	type ErrorResponses = Record<string, { content: { 'application/json': { schema: unknown } } }>;
	const paths = committed['paths'] as Record<
		string,
		Record<string, { operationId: string; responses: ErrorResponses }>
	>;
	const reasonsListed = (operationId: string, status: number): unknown => {
		const operation = Object.values(paths)
			.flatMap((methods) => Object.values(methods))
			.find((op) => op.operationId === operationId)!;
		const schema = operation.responses[String(status)]?.content['application/json'].schema as
			| {
					allOf?: Array<{
						properties?: {
							error: { properties: { data: { properties: { reason: { enum: string[] } } } } };
						};
					}>;
			  }
			| undefined;
		return schema?.allOf?.[1]?.properties?.error.properties.data.properties.reason.enum ?? [];
	};

	it('lists every refusal of the send route under the status it answers with', () => {
		for (const reason of TRANSACTIONAL_REFUSAL_REASONS) {
			expect(reasonsListed('sendTransactional', ERROR_REASON_STATUS[reason]), reason).toContain(
				reason
			);
		}
	});

	it('lists the deletion refusal on every operation that writes, and on no read', () => {
		for (const operation of PUBLIC_OPERATIONS) {
			const listed = reasonsListed(operation.operationId, 422);
			if (operation.method === 'GET') {
				expect(listed, operation.operationId).not.toContain('workspace_deletion_in_progress');
			} else {
				expect(listed, operation.operationId).toContain('workspace_deletion_in_progress');
			}
		}
	});

	it("describes the send route's invalid_variables data: the field and the variables", () => {
		const send = Object.values(paths)
			.flatMap((methods) => Object.values(methods))
			.find((op) => op.operationId === 'sendTransactional')!;
		const invalid = send.responses['400']!.content['application/json'].schema as {
			allOf: Array<{
				properties?: { error: { properties: { data: { properties: Record<string, unknown> } } } };
			}>;
		};
		expect(invalid.allOf[1]!.properties!.error.properties.data.properties).toMatchObject({
			reason: { enum: ['invalid_variables'] },
			field: { type: 'string' },
			variables: { type: 'array', items: { type: 'string' } },
		});
		// Every other 400 of the route names its own field.
		expect(
			invalid.allOf[1]!.properties!.error.properties.data.properties['field']
		).not.toHaveProperty('enum');
	});

	it('lists the key refusals on every keyed operation and none on the open probe', () => {
		for (const operation of PUBLIC_OPERATIONS) {
			for (const reason of API_KEY_ERROR_REASONS) {
				const listed = reasonsListed(operation.operationId, ERROR_REASON_STATUS[reason]);
				if (operation.scope === null) expect(listed, operation.operationId).toEqual([]);
				else if (operation.scope === ANY_KEY && reason === 'missing_scope') {
					expect(listed, operation.operationId).not.toContain(reason);
				} else expect(listed, `${operation.operationId} ${reason}`).toContain(reason);
			}
		}
	});

	it("describes the send route's abuse_blocked data, with the lift the status endpoint returns", () => {
		type DataSchema = {
			properties: Record<string, { anyOf?: Array<{ $ref?: string }> }>;
			required?: string[];
			additionalProperties?: unknown;
		};
		const send = Object.values(paths)
			.flatMap((methods) => Object.values(methods))
			.find((op) => op.operationId === 'sendTransactional')!;
		const forbidden = send.responses['403']!.content['application/json'].schema as {
			allOf: Array<{ properties?: { error: { properties: { data: DataSchema } } } }>;
		};
		const data = forbidden.allOf[1]!.properties!.error.properties.data;
		expect(Object.keys(data.properties).sort()).toEqual(
			['detail', 'lift', 'reason', 'since', 'status'].sort()
		);
		// Optional and open: the other 403 reasons send none of these.
		expect(data.required).toBeUndefined();
		expect(data.additionalProperties).toBeUndefined();

		const schemas = (committed['components'] as { schemas: Record<string, JsonSchema> }).schemas;
		type JsonSchema = {
			properties?: Record<string, JsonSchema>;
			$ref?: string;
			anyOf?: JsonSchema[];
		};
		const statusLift = schemas['DeliveryStatus']!.properties!['sendingHold']!.anyOf!.find(
			(branch) => branch.properties
		)!.properties!['lift']!;
		expect(statusLift.$ref).toBe('#/components/schemas/SendingHoldLift');
		expect(data.properties['lift']!.anyOf!.map((branch) => branch.$ref)).toContain(statusLift.$ref);
	});

	it('names each reason only under a status its operation answers with', () => {
		for (const operation of PUBLIC_OPERATIONS) {
			const statuses = new Set<number>([
				...(operation.scope === null ? [] : KEYED_ERROR_STATUSES),
				...operation.errors,
			]);
			for (const reason of operation.reasons) {
				expect(
					statuses.has(ERROR_REASON_STATUS[reason]),
					`${operation.operationId} ${reason}`
				).toBe(true);
			}
		}
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
