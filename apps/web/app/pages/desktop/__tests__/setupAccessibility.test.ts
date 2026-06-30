import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Markup guard for the desktop setup wizard polish (audit item p3-desktop-polish).
 *
 * These assertions cover the parts of the fix that are template-only (no pure
 * logic to unit-test elsewhere):
 *
 *  - A11y (WCAG 2.4.7): the wizard's custom checkboxes/radios visually hide the
 *    real <input> with `sr-only`. Each MUST be a `peer` whose visible proxy
 *    draws a `focus-visible` ring, or keyboard users see no focus at all.
 *  - Deliverability copy: an MTA install must tell the user the shown A/MX
 *    records are not enough — SPF/DKIM/DMARC are finished in Settings → Domains.
 *  - The "real server IP" affordance (a public-IP prompt) is present.
 */

const here = dirname(fileURLToPath(import.meta.url));
const setupVue = readFileSync(resolve(here, '../setup.vue'), 'utf8');

describe('desktop setup wizard — accessibility', () => {
	it('every sr-only custom control is a focus-visible peer (no bare sr-only)', () => {
		// All sr-only inputs must opt into the `peer` so a sibling can show focus.
		const bareSrOnly = setupVue.match(/class="sr-only"/g) ?? [];
		expect(bareSrOnly).toHaveLength(0);

		const peerInputs = setupVue.match(/class="peer sr-only"/g) ?? [];
		const focusRings = setupVue.match(/peer-focus-visible:ring-brand/g) ?? [];
		// Packs (1) + seedDemo (1) + the two dev-mode radios (2) = 4 controls.
		expect(peerInputs.length).toBeGreaterThanOrEqual(4);
		// Each peer input has a proxy span that draws the focus ring.
		expect(focusRings.length).toBeGreaterThanOrEqual(peerInputs.length);
	});

	it('the password reveal toggle has a focus-visible ring', () => {
		expect(setupVue).toMatch(/aria-label="[^"]*password/);
		expect(setupVue).toContain('focus-visible:ring-brand');
	});
});

describe('desktop setup wizard — deliverability + real IP copy', () => {
	it('warns that A/MX alone are not deliverable and points to Settings → Domains', () => {
		expect(setupVue).toContain('SPF, DKIM and DMARC');
		expect(setupVue).toContain('Settings → Domains');
	});

	it('prompts for the server public IP when connected by hostname', () => {
		expect(setupVue).toContain("Server's public IP");
		expect(setupVue).toContain('v-model="publicIp"');
	});
});
