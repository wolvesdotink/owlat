/**
 * The OpenAPI 3.1 document of the public v1 API, built from the operation
 * table and the schemas. `openapi.json` at the package root is its committed
 * output; `bun run openapi:check` fails when that file is stale.
 */

import { z } from 'zod';
import { apiErrorResponseSchema, paginationMetaSchema } from './common';
import { OPERATION_EXAMPLES, type OperationExample } from './examples';
import {
	KEYED_ERROR_STATUSES,
	PUBLIC_OPERATIONS,
	reasonsAt,
	type PublicOperation,
} from './operations';
import { sendingDomainSetupSchema } from './domains';
import { sendingHoldLiftSchema } from './status';
import { transactionalAttachmentSchema } from './transactional';
import type { ApiErrorReason } from './types';

type JsonObject = Record<string, unknown>;

const STATUS_TEXT: Record<number, string> = {
	400: 'The request is malformed or fails validation.',
	401: 'The API key is missing, malformed or unknown.',
	403: 'The API key lacks the scope this operation needs, or the feature is disabled.',
	404: 'A resource the request names does not exist.',
	409: 'The request conflicts with existing data or reuses an Idempotency-Key.',
	422: 'The workspace is not in a state that can carry out the request.',
	429: 'Too many requests; retry after the `Retry-After` header.',
	500: 'The server failed to complete the request.',
};

const RATE_LIMIT_HEADERS: JsonObject = {
	'X-RateLimit-Limit': {
		description: 'Requests allowed per window for this key.',
		schema: { type: 'integer' },
	},
	'X-RateLimit-Remaining': {
		description:
			'A fixed value: 0 on a 429 from the per-key limit, otherwise one less than the limit. Not a count of the requests left; back off by the Retry-After of a 429.',
		schema: { type: 'integer' },
	},
	'X-RateLimit-Reset': {
		description: 'A Unix timestamp one second after the response; not when the limit refills.',
		schema: { type: 'integer' },
	},
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/**
 * Named JSON Schemas for one direction. Requests are converted as input (an
 * object accepts unknown fields), responses as output (an object holds
 * exactly its documented fields).
 */
function componentSchemas(
	entries: ReadonlyArray<readonly [string, z.ZodType]>,
	io: 'input' | 'output'
): Record<string, JsonObject> {
	const registry = z.registry<{ id: string }>();
	for (const [id, schema] of entries) {
		if (!registry.has(schema)) registry.add(schema, { id });
	}
	const { schemas } = z.toJSONSchema(registry, {
		io,
		unrepresentable: 'throw',
		uri: (id) => `#/components/schemas/${id}`,
	});
	const out: Record<string, JsonObject> = {};
	for (const [id, schema] of Object.entries(schemas)) {
		const { $schema: _dialect, $id: _id, ...rest } = schema as JsonObject;
		out[id] = withoutSafeIntegerBounds(rest) as JsonObject;
	}
	return out;
}

/**
 * Drop the `±Number.MAX_SAFE_INTEGER` bounds zod attaches to every integer:
 * they restate what `integer` means to a JavaScript server and are noise to
 * every other reader of the document.
 */
function withoutSafeIntegerBounds(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(withoutSafeIntegerBounds);
	if (!node || typeof node !== 'object') return node;
	const out: JsonObject = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === 'minimum' && value === Number.MIN_SAFE_INTEGER) continue;
		if (key === 'maximum' && value === Number.MAX_SAFE_INTEGER) continue;
		out[key] = withoutSafeIntegerBounds(value);
	}
	return out;
}

function successBody(operation: PublicOperation): JsonObject {
	const { name, paginated } = operation.success;
	const data = paginated ? { type: 'array', items: ref(name) } : ref(name);
	const properties: JsonObject = paginated ? { data, pagination: ref('PaginationMeta') } : { data };
	return {
		type: 'object',
		properties,
		required: Object.keys(properties),
		additionalProperties: false,
	};
}

/**
 * The `error.data` fields a reason carries beyond `reason`. Optional, because
 * the other reasons at the same status send none of them, and `data` stays
 * open to fields a later release adds.
 */
const REASON_DATA: Partial<Record<ApiErrorReason, JsonObject>> = {
	abuse_blocked: {
		status: {
			type: 'string',
			enum: ['suspended', 'banned'],
			description: 'Whether sending is suspended or banned.',
		},
		since: {
			type: ['string', 'null'],
			description: 'ISO 8601 timestamp of when the status was set; null if not recorded.',
		},
		detail: {
			type: ['string', 'null'],
			description: 'The reason recorded with the status, or null.',
		},
		// The status endpoint's own schema, so the two cannot drift apart.
		lift: {
			anyOf: [ref('SendingHoldLift'), { type: 'null' }],
			description:
				"How the suspension lifts, as GET /api/v1/status's sendingHold.lift; null only if it lifted while the request ran.",
		},
	},
};

/**
 * The error body at one status: the shared envelope, and when the operation
 * names reasons at that status, `error.data.reason` narrowed to them and the
 * fields those reasons carry.
 */
function errorBody(reasons: readonly ApiErrorReason[]): JsonObject {
	if (reasons.length === 0) return ref('ApiErrorResponse');
	return {
		allOf: [
			ref('ApiErrorResponse'),
			{
				type: 'object',
				properties: {
					error: {
						type: 'object',
						properties: {
							data: {
								type: 'object',
								properties: {
									reason: {
										type: 'string',
										enum: reasons,
										description:
											'Why the request was refused. New reasons can be added; treat an unknown one by its HTTP status.',
									},
									...Object.assign({}, ...reasons.map((reason) => REASON_DATA[reason] ?? {})),
								},
							},
						},
					},
				},
			},
		],
	};
}

function errorResponse(status: number, reasons: readonly ApiErrorReason[]): JsonObject {
	return {
		description: STATUS_TEXT[status] ?? 'Error.',
		...(status === 429
			? {
					headers: {
						'Retry-After': {
							description: 'Seconds to wait before retrying.',
							schema: { type: 'integer' },
						},
					},
				}
			: {}),
		content: { 'application/json': { schema: errorBody(reasons) } },
	};
}

function operationObject(operation: PublicOperation): JsonObject {
	const example: OperationExample | undefined =
		OPERATION_EXAMPLES[operation.operationId as keyof typeof OPERATION_EXAMPLES];
	const keyed = operation.scope !== null;
	const parameters: JsonObject[] = [
		...operation.pathParameters.map((parameter) => ({
			name: parameter.name,
			in: 'path',
			required: true,
			description: parameter.description,
			schema: { type: 'string' },
		})),
		...operation.queryParameters.map((parameter) => ({
			name: parameter.name,
			in: 'query',
			required: false,
			description: parameter.description,
			schema: parameter.schema,
		})),
		...(operation.idempotent
			? [
					{
						name: 'Idempotency-Key',
						in: 'header',
						required: false,
						description:
							'Makes the request safe to retry: the server applies it at most once per key for 24 hours and answers a repeat with the first response. 1 to 255 printable ASCII characters without spaces.',
						schema: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[!-~]+$' },
					},
				]
			: []),
	];
	const successHeaders: JsonObject = {
		...(keyed ? RATE_LIMIT_HEADERS : {}),
		...(operation.idempotent
			? {
					'Idempotent-Replayed': {
						description: '`true` when the response repeats the first answer to this key.',
						schema: { type: 'string', enum: ['true'] },
					},
				}
			: {}),
	};
	const errorStatuses = [
		...new Set([...(keyed ? KEYED_ERROR_STATUSES : []), ...operation.errors]),
	].sort((a, b) => a - b);
	return {
		operationId: operation.operationId,
		tags: [operation.tag],
		summary: operation.summary,
		security: keyed ? [{ apiKey: [operation.scope] }] : [],
		...(parameters.length ? { parameters } : {}),
		...(operation.request
			? {
					requestBody: {
						required: true,
						content: {
							'application/json': {
								schema: ref(operation.request.name),
								...(example?.request === undefined ? {} : { example: example.request }),
							},
						},
					},
				}
			: {}),
		responses: {
			[String(operation.success.status)]: {
				description: operation.success.description,
				...(Object.keys(successHeaders).length ? { headers: successHeaders } : {}),
				content: {
					'application/json': {
						schema: successBody(operation),
						...(example ? { example: example.response } : {}),
					},
				},
			},
			...Object.fromEntries(
				errorStatuses.map((status) => [
					String(status),
					errorResponse(status, reasonsAt(operation, status)),
				])
			),
		},
	};
}

/** The OpenAPI document, deterministic for a given contract. */
export function buildOpenApiDocument(
	operations: readonly PublicOperation[] = PUBLIC_OPERATIONS
): JsonObject {
	const requests = componentSchemas(
		[
			['TransactionalAttachment', transactionalAttachmentSchema],
			...operations.flatMap((operation) =>
				operation.request ? [[operation.request.name, operation.request.schema] as const] : []
			),
		],
		'input'
	);
	const responses = componentSchemas(
		[
			['ApiErrorResponse', apiErrorResponseSchema],
			['PaginationMeta', paginationMetaSchema],
			['SendingDomainSetup', sendingDomainSetupSchema],
			['SendingHoldLift', sendingHoldLiftSchema],
			...operations.map((operation) => [operation.success.name, operation.success.data] as const),
		],
		'output'
	);
	const paths: Record<string, JsonObject> = {};
	for (const operation of operations) {
		paths[operation.path] = {
			...paths[operation.path],
			[operation.method.toLowerCase()]: operationObject(operation),
		};
	}
	return {
		openapi: '3.1.0',
		info: {
			title: 'Owlat API',
			version: 'v1',
			description:
				'The public REST API of an Owlat instance. Generated from `@owlat/public-contract`; do not edit by hand.',
		},
		servers: [
			{
				url: '{baseUrl}',
				// Every install serves its own API; a real host as the default
				// would send a caller's key to someone else's server.
				variables: {
					baseUrl: {
						default: 'https://rest.api.example.com',
						description:
							"Your instance's API URL: 'Your API base URL' under Settings → API → API quickstart, set by the operator as NUXT_PUBLIC_CONVEX_SITE_URL.",
					},
				},
			},
		],
		tags: ['Contacts', 'Events', 'Transactional', 'Topics', 'Status', 'Domains', 'Health'].map(
			(name) => ({ name })
		),
		paths,
		components: {
			securitySchemes: {
				apiKey: {
					type: 'http',
					scheme: 'bearer',
					description:
						'An Owlat API key, sent as `Authorization: Bearer <key>`. Each operation lists the scope the key needs.',
				},
			},
			schemas: sortKeys({ ...requests, ...responses }),
		},
	};
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
	return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

/** The committed file's text for a document: tab-indented JSON and a final newline. */
export function serializeOpenApiDocument(document: JsonObject): string {
	return `${JSON.stringify(document, null, '\t')}\n`;
}
