import { describe, expect, it } from 'vitest';
import { guardRecoveryKitExport, type RecoveryKitGateDeps } from '../recoveryKitGate';

/**
 * The recovery kit is the one sanctioned way a private key leaves the vault, and
 * on the member path (plan idea 55) the ORDER of the checks in front of it is
 * the security property. These tests hold that order in place: each case records
 * which dependencies actually ran, so a refactor that hashes a password before
 * the rate limit, or assembles a kit before the password is verified, fails here
 * rather than in production.
 */

/** A gate whose dependencies record their calls, with every check passing by default. */
function harness(overrides: Partial<RecoveryKitGateDeps<string>> = {}) {
	const calls: string[] = [];
	const track =
		<T>(name: string, value: T) =>
		async () => {
			calls.push(name);
			return value;
		};
	const deps: RecoveryKitGateDeps<string> = {
		isFeatureEnabled: track('isFeatureEnabled', true),
		ownsAddress: track('ownsAddress', true),
		isThrottled: track('isThrottled', false),
		verifyPassword: track('verifyPassword', true),
		recordFailure: track('recordFailure', undefined),
		exportKit: track('exportKit', 'KIT'),
		...Object.fromEntries(
			Object.entries(overrides).map(([name, fn]) => [
				name,
				async () => {
					calls.push(name);
					return (fn as () => unknown)();
				},
			])
		),
	};
	return { deps, calls };
}

describe('guardRecoveryKitExport', () => {
	it('hands back the kit once all four checks pass', async () => {
		const { deps, calls } = harness();
		await expect(guardRecoveryKitExport(deps)).resolves.toEqual({ ok: true, kit: 'KIT' });
		expect(calls).toEqual([
			'isFeatureEnabled',
			'ownsAddress',
			'isThrottled',
			'verifyPassword',
			'exportKit',
		]);
	});

	it('refuses with the flag off before touching anything else', async () => {
		const { deps, calls } = harness({ isFeatureEnabled: async () => false });
		await expect(guardRecoveryKitExport(deps)).resolves.toEqual({
			ok: false,
			reason: 'feature_off',
		});
		expect(calls).toEqual(['isFeatureEnabled']);
	});

	it('checks ownership BEFORE the password, so a foreign address costs no guess', async () => {
		const { deps, calls } = harness({ ownsAddress: async () => false });
		await expect(guardRecoveryKitExport(deps)).resolves.toEqual({
			ok: false,
			reason: 'not_your_address',
		});
		expect(calls).toEqual(['isFeatureEnabled', 'ownsAddress']);
		expect(calls).not.toContain('verifyPassword');
		expect(calls).not.toContain('exportKit');
	});

	it('stops a throttled caller before any password verification runs', async () => {
		const { deps, calls } = harness({ isThrottled: async () => true });
		await expect(guardRecoveryKitExport(deps)).resolves.toEqual({ ok: false, reason: 'throttled' });
		expect(calls).toEqual(['isFeatureEnabled', 'ownsAddress', 'isThrottled']);
		expect(calls).not.toContain('verifyPassword');
	});

	it('never assembles a kit when the password is wrong, and records the failure', async () => {
		const { deps, calls } = harness({ verifyPassword: async () => false });
		await expect(guardRecoveryKitExport(deps)).resolves.toEqual({
			ok: false,
			reason: 'bad_password',
		});
		expect(calls).toEqual([
			'isFeatureEnabled',
			'ownsAddress',
			'isThrottled',
			'verifyPassword',
			'recordFailure',
		]);
		expect(calls).not.toContain('exportKit');
	});

	it('records nothing when the password is right', async () => {
		const { calls } = harness();
		expect(calls).not.toContain('recordFailure');
	});

	it('reports an address with no active key honestly rather than as an auth failure', async () => {
		const { deps } = harness({ exportKit: async () => null });
		await expect(guardRecoveryKitExport(deps)).resolves.toEqual({ ok: false, reason: 'no_key' });
	});
});
