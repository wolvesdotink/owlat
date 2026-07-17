/**
 * Connected-app lifecycle state machine (Tier 2).
 *
 * A connected app is an external service that talks to Owlat through scoped,
 * plugin-bound credentials and signed hooks. Its lifecycle is a small, explicit
 * state machine so the legality of every transition is testable in one place and
 * cannot drift across the mutations that apply it.
 *
 * Statuses:
 *   - `enabled`  — active; runtime authorizers admit its scoped calls.
 *   - `disabled` — temporarily off; re-enable restores it.
 *   - `revoked`  — terminal kill switch; the shared secret is invalidated and
 *                  the app can never be re-enabled. Registration is required to
 *                  start over.
 *
 * `register` creates a record directly in `enabled`; `delete` removes the record
 * entirely and is legal from any status. Neither is a status→status edge, so
 * both live outside {@link nextConnectedAppStatus} — this function models only
 * the enable/disable/revoke edges between existing records.
 *
 * This module is pure: no Convex, no Node, no I/O. It is the single source of
 * truth for transition legality; mutations translate a `null` result into the
 * repository's `invalid_state` error.
 */

export const CONNECTED_APP_STATUSES = ['enabled', 'disabled', 'revoked'] as const;
export type ConnectedAppStatus = (typeof CONNECTED_APP_STATUSES)[number];

/** The status→status transitions a caller can request on an existing record. */
export const CONNECTED_APP_TRANSITIONS = ['enable', 'disable', 'revoke'] as const;
export type ConnectedAppTransition = (typeof CONNECTED_APP_TRANSITIONS)[number];

const CONNECTED_APP_STATUS_SET: ReadonlySet<string> = new Set(CONNECTED_APP_STATUSES);

/** True iff `value` is a known connected-app status literal. */
export function isConnectedAppStatus(value: string): value is ConnectedAppStatus {
	return CONNECTED_APP_STATUS_SET.has(value);
}

/**
 * The legal transition table. A `revoked` app is terminal — no edge leaves it.
 * An `enable` on an already-enabled app (and the symmetric `disable`) is an
 * illegal no-op, not a silent success, so the caller learns the request was
 * meaningless rather than masking a UI/state bug.
 */
const TRANSITION_TABLE: Readonly<
	Record<ConnectedAppStatus, Readonly<Partial<Record<ConnectedAppTransition, ConnectedAppStatus>>>>
> = Object.freeze({
	enabled: Object.freeze({ disable: 'disabled', revoke: 'revoked' } as const),
	disabled: Object.freeze({ enable: 'enabled', revoke: 'revoked' } as const),
	revoked: Object.freeze({} as const),
});

/**
 * Resolve the status that results from applying `transition` to a record
 * currently in `current`. Returns the next status for a legal edge, or `null`
 * when the transition is illegal (terminal source, or a redundant no-op).
 */
export function nextConnectedAppStatus(
	current: ConnectedAppStatus,
	transition: ConnectedAppTransition
): ConnectedAppStatus | null {
	return TRANSITION_TABLE[current][transition] ?? null;
}

/**
 * Whether a revoke has already invalidated the shared secret. Revocation is a
 * one-way kill switch: once revoked, secret rotation and re-enable are both
 * illegal, and the sealed secret on the row is dead even though it is retained
 * for audit history until the record is deleted.
 */
export function isConnectedAppRevoked(status: ConnectedAppStatus): boolean {
	return status === 'revoked';
}
