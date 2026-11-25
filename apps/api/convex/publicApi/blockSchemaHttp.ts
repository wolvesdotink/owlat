/**
 * GET /api/v1/schemas/blocks.json — the JSON Schema of block content: the
 * `blocks` of a template, transactional email or saved block. A client or an
 * agent that writes blocks reads from the instance it writes to which block
 * types and fields that instance takes.
 *
 * The schema is generated from the block types into
 * `@owlat/public-contract/schemas/blocks.json`; this route serves that file
 * as it is.
 */

import blockSchema from '@owlat/public-contract/schemas/blocks.json';
import { httpAction } from '../_generated/server';
import { publicCorsHeaders } from '../lib/httpResponse';

/** Serialized once per isolate: the schema is fixed for a deployed bundle. */
const schemaText = JSON.stringify(blockSchema);

// public: the schema describes the open-source block format and holds no data
// of the instance. Like the OpenAPI document it is not rate limited, since the
// answer is a cached string and a limiter would cost a database write per
// request. CORS allows any origin, since no credential rides along.
export const getBlockSchema = httpAction(async (_ctx, request) => {
	const headers = publicCorsHeaders('GET, OPTIONS');
	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers });
	}
	return new Response(schemaText, {
		status: 200,
		headers: {
			...headers,
			'Content-Type': 'application/schema+json',
			'Cache-Control': 'public, max-age=300',
		},
	});
});
