// @vitest-environment node
/**
 * The setup must wait out the welcome stamp's slowest recovery, or a retry
 * that would have committed fails the setup instead (#1203 review).
 */
import { describe, expect, it } from 'vitest';
import { welcomeStampWorstCaseMs } from '~/lib/welcomeStamp';
import { WELCOME_STAMP_SETTLE_MS } from '~~/e2e/timing';

describe('E2E setup timing', () => {
	it('waits at least as long as a welcome stamp run can take', () => {
		expect(WELCOME_STAMP_SETTLE_MS).toBeGreaterThanOrEqual(welcomeStampWorstCaseMs());
	});

	it('keeps the stamp run short enough to wait out in CI', () => {
		// Bounded so a longer deadline or auth wait is a deliberate change here.
		expect(welcomeStampWorstCaseMs()).toBeLessThanOrEqual(90_000);
	});
});
