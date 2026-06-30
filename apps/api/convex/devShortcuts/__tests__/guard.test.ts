/**
 * Unit tests for the dev-deployment guard used by every dev-only endpoint.
 *
 * The guard is the single line of defense that stops `/seed/demo`,
 * `/dev/reset`, and `api.devShortcuts.forceVerifyDomain` from running on prod.
 * The "fail-closed by default" property is the one we cannot afford to ship
 * broken.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertDevDeployment, devDeploymentResponseOrNull, isDevDeployment } from '../_guard';

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('dev-deployment guard', () => {
	it('fail-closed: unset OWLAT_DEV_MODE refuses', () => {
		vi.stubEnv('OWLAT_DEV_MODE', '');
		expect(isDevDeployment()).toBe(false);
		expect(() => assertDevDeployment()).toThrow(/refused/i);
		const resp = devDeploymentResponseOrNull();
		expect(resp).not.toBeNull();
		expect(resp!.status).toBe(403);
	});

	it('accepts truthy values', () => {
		for (const value of ['true', '1', 'yes', 'on', 'TRUE', 'Yes']) {
			vi.stubEnv('OWLAT_DEV_MODE', value);
			expect(isDevDeployment()).toBe(true);
			expect(() => assertDevDeployment()).not.toThrow();
			expect(devDeploymentResponseOrNull()).toBeNull();
		}
	});

	it('refuses falsy / unexpected values', () => {
		for (const value of ['false', '0', 'no', 'off', 'maybe', 'prod']) {
			vi.stubEnv('OWLAT_DEV_MODE', value);
			expect(isDevDeployment()).toBe(false);
		}
	});
});
