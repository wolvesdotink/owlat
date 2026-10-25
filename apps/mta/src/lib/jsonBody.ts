/**
 * The MTA's adapter for `@owlat/worker-protocol/decodeJson`: every route that
 * takes a JSON body reads it through here, so the body is capped, parsed to
 * `unknown` and checked before the handler touches a field, and a refusal is
 * the MTA's usual `{ error }` envelope.
 */

import type { Context } from 'hono';
import {
	decodeJson,
	type Checked,
	type DecodeJsonOptions,
	type JsonChecker,
} from '@owlat/worker-protocol/decodeJson';

/**
 * The cap for an admin route's body: a handful of fields, or a suppression
 * batch of up to 10,000 addresses at 320 octets each plus their framing.
 */
export const ADMIN_BODY_MAX_BYTES = 8 * 1024 * 1024;

export interface JsonBodyOptions extends DecodeJsonOptions {
	/** Defaults to {@link ADMIN_BODY_MAX_BYTES}. */
	readonly maxBytes?: number;
	/** The `error` a 400 answers with, in place of the decoder's own wording. */
	readonly invalidMessage?: string;
	/** The `error` a 413 answers with, in place of the decoder's own wording. */
	readonly tooLargeMessage?: string;
}

export type JsonBodyRead<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly response: Response };

export async function readJsonBody<C extends JsonChecker>(
	c: Context,
	checker: C,
	options: JsonBodyOptions = {}
): Promise<JsonBodyRead<Checked<C>>> {
	const {
		maxBytes = ADMIN_BODY_MAX_BYTES,
		invalidMessage,
		tooLargeMessage,
		...decodeOptions
	} = options;
	const result = await decodeJson(c.req.raw, checker, maxBytes, decodeOptions);
	if (result.ok) return result;
	const { failure } = result;
	const error =
		failure.status === 413
			? (tooLargeMessage ?? failure.message)
			: (invalidMessage ?? failure.message);
	// A refused body may be partly unread, so the connection cannot carry
	// another request after it.
	if (failure.status === 413) c.header('Connection', 'close');
	return { ok: false, response: c.json({ error }, failure.status) };
}
