/**
 * The decode step of a provider webhook: a verified body is parsed to
 * `unknown` and checked before an adapter reads a field of it.
 *
 * An adapter runs after authentication, so the sender is the provider, but a
 * signature proves who sent a body, not what is in it. A field the adapter
 * consumes is checked here (or normalized by the adapter itself), so a `from`
 * that is a number is refused at the transport instead of reaching the
 * dispatcher and failing a mutation's validator further in.
 *
 * A refusal THROWS: `runInboundPipeline` answers a throwing parser with
 * `400 Invalid event payload`, after the raw-payload audit row has been
 * written. The error names the path and the expected type, never the value.
 *
 * Unknown keys are ignored (the decoder's default): a provider that adds a
 * field must not break the route. Checking only what an adapter consumes, and
 * deciding whether an event is one we act on before checking the rest, keeps
 * the "acknowledge what we ignore" answers the providers rely on.
 */

import {
	decodeJsonText,
	decodeJsonValue,
	type Checked,
	type JsonBody,
	type JsonChecker,
} from '@owlat/worker-protocol/decodeJson';

function unwrap<T>(decoded: JsonBody<T>, source: string): T {
	if (decoded.ok) return decoded.value;
	const { failure } = decoded;
	throw new TypeError(
		`${source} webhook: ${failure.kind === 'invalid' ? failure.issue : failure.message}`
	);
}

/** Parse a verified webhook body and check it, or throw a path-only TypeError. */
export function decodeWebhookBody<C extends JsonChecker>(
	rawBody: string,
	checker: C,
	source: string
): Checked<C> {
	return unwrap(decodeJsonText(rawBody, checker), source);
}

/** Check a value already parsed out of a verified webhook body, or throw. */
export function decodeWebhookValue<C extends JsonChecker>(
	value: unknown,
	checker: C,
	source: string
): Checked<C> {
	return unwrap(decodeJsonValue(value, checker), source);
}
