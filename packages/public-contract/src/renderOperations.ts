/**
 * The operations that render without storing or sending: `POST
 * /api/v1/render` and the dry run of a send, spliced into the table in
 * `./operations.ts`.
 */

import { renderRequestSchema, renderResultSchema, sendTransactionalDryRunSchema } from './render';
import { sendTransactionalRequestSchema } from './transactional';
import { RENDER_REFUSAL_REASONS, TRANSACTIONAL_REFUSAL_REASONS } from './types';
import type { PublicOperation } from './operationShape';

export const RENDER_OPERATIONS = [
	{
		operationId: 'renderEmail',
		method: 'POST',
		path: '/api/v1/render',
		tag: 'Templates',
		summary:
			'Render block content as this instance would store it, without storing anything: the HTML, the text body and the subject, the issues the content check of a write finds, and a health score. With dataVariables a transactional email is composed as a send composes it.',
		scope: 'templates:read',
		pathParameters: [],
		queryParameters: [],
		idempotent: false,
		request: { name: 'RenderRequest', schema: renderRequestSchema },
		success: {
			status: 200,
			description: 'The rendered email. Nothing was stored.',
			name: 'RenderResult',
			data: renderResultSchema,
			paginated: false,
		},
		errors: [],
		reasons: [
			'feature_disabled',
			'invalid_content',
			'content_too_large',
			'invalid_variables',
			...RENDER_REFUSAL_REASONS,
		],
	},
	{
		operationId: 'dryRunTransactional',
		method: 'POST',
		path: '/api/v1/transactional/dry-run',
		tag: 'Transactional',
		summary:
			'Compose the email a send of this request would queue, and answer the refusal the send would meet now, without sending. Nothing is sent, stored or counted. An instance without dry runs answers 404 here and sends nothing.',
		scope: 'transactional:send',
		pathParameters: [],
		queryParameters: [],
		idempotent: false,
		request: { name: 'SendTransactionalRequest', schema: sendTransactionalRequestSchema },
		success: {
			status: 200,
			description: 'What the send would deliver, and whether it would be queued. Nothing was sent.',
			name: 'SendTransactionalDryRun',
			data: sendTransactionalDryRunSchema,
			paginated: false,
		},
		errors: [404, 422],
		// A refusal that leaves nothing to compose is answered as the send
		// answers it. A dry run uses no Idempotency-Key.
		reasons: [
			...TRANSACTIONAL_REFUSAL_REASONS.filter((reason) => !reason.startsWith('idempotency_')),
			...RENDER_REFUSAL_REASONS,
		],
	},
] as const satisfies readonly PublicOperation[];
