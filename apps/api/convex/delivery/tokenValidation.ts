/**
 * The result shape returned by the contact-token validation actions
 * (`internal.delivery.{unsubscribe,preferences}.validateToken`), shared by the
 * two public token HTTP endpoints that call them. A valid token resolves to a
 * `contactId`; an invalid one still echoes the parsed `contactId` (possibly the
 * empty string) plus a machine-readable `reason`.
 *
 * Distinct from `ContactTokenResult` in `./contactToken` — that is the codec's
 * `{ contactId; valid; reason? }` flat record; this is the discriminated union
 * the actions hand back to the HTTP layer.
 */
export type TokenValidation =
	| { valid: true; contactId: string }
	| { valid: false; contactId: string; reason: string };
