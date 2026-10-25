import { decodeJsonValue, parserDecoder } from '@owlat/worker-protocol/decodeJson';
import { isRecord } from '@owlat/shared/utils/guards';

/**
 * What a token endpoint's answer says, read from its JSON body: the Convex
 * token route (`/api/auth/convex/token`) and BetterAuth's one-time token route
 * both answer `{ "token": "<token>" }`.
 *
 * - `token`: the token, or `null` when the answer carries none (an absent or
 *   null field, or an empty string): the server has no session to issue one for;
 * - `unusable`: a body that is not JSON, not an object, or whose `token` is not
 *   a string. That says nothing about the session, so a caller must not treat
 *   it as signed out.
 */
export type AuthTokenAnswer = { kind: 'token'; token: string | null } | { kind: 'unusable' };

const tokenDecoder = parserDecoder((value): { token: string | null } | null => {
	if (!isRecord(value)) return null;
	const { token } = value;
	if (token === undefined || token === null) return { token: null };
	return typeof token === 'string' ? { token: token || null } : null;
}, '$.token: expected a string or null');

/**
 * Read a token endpoint's body as returned by `response.json()`; a caller
 * passes `undefined` for a body that was not JSON.
 */
export function readAuthTokenAnswer(body: unknown): AuthTokenAnswer {
	const decoded = decodeJsonValue(body, tokenDecoder);
	return decoded.ok ? { kind: 'token', token: decoded.value.token } : { kind: 'unusable' };
}
