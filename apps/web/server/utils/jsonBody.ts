import type { H3Event } from 'h3';
import {
	decodeJson,
	nodeRequestSource,
	type Checked,
	type DecodeJsonOptions,
	type JsonChecker,
} from '@owlat/worker-protocol/decodeJson';

/**
 * The largest body a server route reads: the setup wizard's whole configuration
 * (flags, env, admin) is the biggest, at a few KB.
 */
const JSON_BODY_MAX_BYTES = 1024 * 1024;

export interface JsonBodyOptions extends DecodeJsonOptions {
	/** The 400's message, in place of the decoder's, for a route with its own wording. */
	readonly invalidMessage?: string;
}

/**
 * Read a server route's JSON body, capped, parsed to `unknown` and checked,
 * or throw the 400/413 refusing it before the route does anything else.
 *
 * Replaces h3's `readBody<T>()`, whose type argument checks nothing and which
 * buffers a body of any size.
 */
export async function readJsonBody<C extends JsonChecker>(
	event: H3Event,
	checker: C,
	options: JsonBodyOptions = {}
): Promise<Checked<C>> {
	const { invalidMessage, ...decodeOptions } = options;
	const result = await decodeJson(
		nodeRequestSource(event.node.req),
		checker,
		JSON_BODY_MAX_BYTES,
		decodeOptions
	);
	if (result.ok) return result.value;
	const { failure } = result;
	if (failure.status === 413) {
		// The unread rest is drained, not answered: no further request on this
		// connection.
		event.node.res.setHeader('Connection', 'close');
	}
	throw createError({
		statusCode: failure.status,
		message: failure.status === 400 ? (invalidMessage ?? failure.message) : failure.message,
	});
}
