/**
 * THE SETUP FORK (plan D14) — two paths, offered as EQUAL choices.
 *
 * The failure this suite exists to catch is a soft one: a "recommended" badge, a
 * pre-selection that steers a fresh install toward buying an ESP, or a trade-off
 * stated on one path and left implicit on the other. All three are the same bug
 * — the fork stops being a choice — and none of them would fail a type check.
 */

import { describe, expect, it } from 'vitest';
import { RAMP_SETUP_PATHS, resolveSetupFork } from '../setupFork';

describe('both paths are offered as equal choices', () => {
	it('offers exactly the two paths, in a stable order', () => {
		expect(RAMP_SETUP_PATHS.map((path) => path.id)).toEqual(['own_server', 'esp_relay']);
	});

	it('labels NEITHER path recommended', () => {
		for (const path of RAMP_SETUP_PATHS) expect(path.isRecommended).toBe(false);
	});

	it('states the trade-off plainly on BOTH paths', () => {
		for (const path of RAMP_SETUP_PATHS) {
			expect(path.tradeOff.length).toBeGreaterThan(20);
			expect(path.summary.length).toBeGreaterThan(20);
			expect(path.title.length).toBeGreaterThan(0);
		}
	});

	it('names the actuator each path drives (plan D3)', () => {
		expect(RAMP_SETUP_PATHS.find((path) => path.id === 'own_server')?.actuator).toBe('pace');
		expect(RAMP_SETUP_PATHS.find((path) => path.id === 'esp_relay')?.actuator).toBe('share');
	});

	it('uses no comparative or promotional language on either path', () => {
		for (const path of RAMP_SETUP_PATHS) {
			const copy = `${path.title} ${path.summary} ${path.tradeOff}`;
			expect(copy).not.toMatch(/recommended|best|preferred|better than|should/i);
		}
	});
});

describe('pre-selection follows what is already configured', () => {
	it('pre-selects nothing on a fresh install', () => {
		const fork = resolveSetupFork({ hasRelayConfigured: false });
		expect(fork.preselected).toBeNull();
		expect(fork.paths).toEqual(RAMP_SETUP_PATHS);
	});

	it('pre-selects the ESP path ONLY when a relay already exists', () => {
		expect(resolveSetupFork({ hasRelayConfigured: true }).preselected).toBe('esp_relay');
	});

	it('never pre-selects the ESP path for a deployment without one', () => {
		expect(resolveSetupFork({ hasRelayConfigured: false }).preselected).not.toBe('esp_relay');
	});
});
