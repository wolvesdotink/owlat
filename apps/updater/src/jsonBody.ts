/**
 * How the updater's endpoint handlers read a request body: capped, parsed and
 * checked by one of the parsers in requestBodies.ts before a handler reads a
 * field.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
	decodeJson,
	nodeRequestSource,
	type Checked,
	type DecodeJsonOptions,
	type JsonChecker,
} from '@owlat/worker-protocol/decodeJson';
import { json } from './http.js';

/**
 * The largest body an endpoint reads. The biggest is /update's compose
 * template, a few tens of KB; every other body is a handful of fields.
 */
const BODY_MAX_BYTES = 1024 * 1024;

/**
 * Read a JSON body under {@link BODY_MAX_BYTES}, parse it and check it, or
 * answer the 400/413 and return `undefined`. Nothing past the cap is buffered.
 */
export async function readJsonBody<C extends JsonChecker>(
	req: IncomingMessage,
	res: ServerResponse,
	checker: C,
	options?: DecodeJsonOptions
): Promise<Checked<C> | undefined> {
	const result = await decodeJson(nodeRequestSource(req), checker, BODY_MAX_BYTES, options);
	if (result.ok) return result.value;
	// The unread rest of a refused body is drained, not answered: the client is
	// told not to send another request on this connection.
	if (result.failure.status === 413) res.setHeader('Connection', 'close');
	json(res, result.failure.status, { error: result.failure.message });
	return undefined;
}
