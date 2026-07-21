import { describe, expect, it } from 'vitest';
import {
	CONNECTED_APP_STATUSES,
	CONNECTED_APP_TRANSITIONS,
	isConnectedAppRevoked,
	isConnectedAppStatus,
	nextConnectedAppStatus,
	type ConnectedAppStatus,
	type ConnectedAppTransition,
} from '../lifecycle';

// The complete, exhaustive legality table. Every (status, transition) pair is
// pinned here; a `null` means the edge is illegal. Changing the state machine
// forces this table to change in lock-step, which is the point.
const EXPECTED: Record<
	ConnectedAppStatus,
	Record<ConnectedAppTransition, ConnectedAppStatus | null>
> = {
	enabled: { enable: null, disable: 'disabled', revoke: 'revoked' },
	disabled: { enable: 'enabled', disable: null, revoke: 'revoked' },
	revoked: { enable: null, disable: null, revoke: null },
};

describe('connected-app lifecycle state machine', () => {
	it.each(CONNECTED_APP_STATUSES)('exhaustively pins every transition from %s', (status) => {
		for (const transition of CONNECTED_APP_TRANSITIONS) {
			expect(nextConnectedAppStatus(status, transition)).toBe(EXPECTED[status][transition]);
		}
	});

	it('treats revoked as terminal: no edge leaves it', () => {
		for (const transition of CONNECTED_APP_TRANSITIONS) {
			expect(nextConnectedAppStatus('revoked', transition)).toBeNull();
		}
		expect(isConnectedAppRevoked('revoked')).toBe(true);
		expect(isConnectedAppRevoked('enabled')).toBe(false);
		expect(isConnectedAppRevoked('disabled')).toBe(false);
	});

	it('rejects redundant no-op transitions instead of masking them as success', () => {
		expect(nextConnectedAppStatus('enabled', 'enable')).toBeNull();
		expect(nextConnectedAppStatus('disabled', 'disable')).toBeNull();
	});

	it('allows the full enable/disable cycle and one-way revoke', () => {
		expect(nextConnectedAppStatus('enabled', 'disable')).toBe('disabled');
		expect(nextConnectedAppStatus('disabled', 'enable')).toBe('enabled');
		expect(nextConnectedAppStatus('enabled', 'revoke')).toBe('revoked');
		expect(nextConnectedAppStatus('disabled', 'revoke')).toBe('revoked');
	});

	it('recognizes exactly the known status literals', () => {
		expect(isConnectedAppStatus('enabled')).toBe(true);
		expect(isConnectedAppStatus('disabled')).toBe(true);
		expect(isConnectedAppStatus('revoked')).toBe(true);
		expect(isConnectedAppStatus('deleted')).toBe(false);
		expect(isConnectedAppStatus('')).toBe(false);
		expect(isConnectedAppStatus('ENABLED')).toBe(false);
	});
});
