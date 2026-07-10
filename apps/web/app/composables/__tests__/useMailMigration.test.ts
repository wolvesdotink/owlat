import { describe, it, expect } from 'vitest';
import { deriveMigrationStep } from '../postbox/useMailMigration';

describe('deriveMigrationStep', () => {
	it('drives the wizard from the migration status when one exists', () => {
		expect(deriveMigrationStep('importing', true)).toBe('importing');
		expect(deriveMigrationStep('indexing', true)).toBe('indexing');
		expect(deriveMigrationStep('completed', true)).toBe('completed');
		expect(deriveMigrationStep('failed', true)).toBe('failed');
		expect(deriveMigrationStep('cancelled', true)).toBe('cancelled');
	});

	it('a migration status wins regardless of connection state', () => {
		// A migration can only exist if a mailbox was connected, but the
		// derivation must not depend on the (separately-fetched) account query.
		expect(deriveMigrationStep('importing', false)).toBe('importing');
		expect(deriveMigrationStep('completed', false)).toBe('completed');
	});

	it('falls back to connect/ready when there is no migration', () => {
		expect(deriveMigrationStep(null, false)).toBe('connect');
		expect(deriveMigrationStep(undefined, false)).toBe('connect');
		expect(deriveMigrationStep(null, true)).toBe('ready');
		expect(deriveMigrationStep(undefined, true)).toBe('ready');
	});

	it('resumes an in-flight import after the wizard is closed and reopened', () => {
		// The wizard is stateless across reloads: on reopen it reads the persisted
		// migration status and lands the user back on the live step, never on the
		// provider picker mid-import.
		expect(deriveMigrationStep('importing', true, 'connected')).toBe('importing');
		expect(deriveMigrationStep('indexing', true, 'connected')).toBe('indexing');
		// Even if the account query hasn't resolved yet on reopen, status wins.
		expect(deriveMigrationStep('importing', false)).toBe('importing');
	});

	it('steers to reconnect when the connected account is in auth_error', () => {
		// The worker won't connect an auth_error account, so a fresh migration would
		// wedge — surface a reconnect prompt instead of a green "ready" Start button.
		expect(deriveMigrationStep(null, true, 'auth_error')).toBe('reconnect');
		expect(deriveMigrationStep(undefined, true, 'auth_error')).toBe('reconnect');
		// A healthy/transient-error account is still ready (those the worker retries).
		expect(deriveMigrationStep(null, true, 'connected')).toBe('ready');
		expect(deriveMigrationStep(null, true, 'error')).toBe('ready');
		// Not connected → still 'connect' regardless of status.
		expect(deriveMigrationStep(null, false, 'auth_error')).toBe('connect');
		// A live migration's status still wins over the account status.
		expect(deriveMigrationStep('importing', true, 'auth_error')).toBe('importing');
	});
});
