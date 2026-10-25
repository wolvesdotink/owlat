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

/**
 * Read a token endpoint's body as returned by `response.json()`; a caller
 * passes `undefined` for a body that was not JSON.
 */
export function readAuthTokenAnswer(body: unknown): AuthTokenAnswer {
	// Checked by this module's own guard, not `@owlat/worker-protocol/decodeJson`:
	// this runs on the boot path, and that module carries the Convex validator
	// matcher into the entry bundle.
	if (!isRecord(body)) return { kind: 'unusable' };
	const { token } = body;
	if (token === undefined || token === null) return { kind: 'token', token: null };
	return typeof token === 'string' ? { kind: 'token', token: token || null } : { kind: 'unusable' };
}
