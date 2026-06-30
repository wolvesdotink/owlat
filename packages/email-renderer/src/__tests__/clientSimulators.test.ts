import { describe, it, expect, afterEach } from 'vitest';
import {
	simulateClient,
	registerClientSimulator,
	unregisterClientSimulator,
	clientSimulators,
	type ClientSimulator,
} from '../simulators';
import type { TargetClient } from '../types';

// =============================================================================
// Bucket 1 — Unit: registry lifecycle for clientSimulators
// =============================================================================
describe('clientSimulators — registry lifecycle', () => {
	it('all five built-in clients are registered at module load', () => {
		expect(clientSimulators.has('gmail')).toBe(true);
		expect(clientSimulators.has('outlookDesktop')).toBe(true);
		expect(clientSimulators.has('outlookNew')).toBe(true);
		expect(clientSimulators.has('yahooMail')).toBe(true);
		expect(clientSimulators.has('appleMail')).toBe(true);
	});

	it('keys() returns exactly the five built-in client names', () => {
		expect(clientSimulators.keys().sort()).toEqual([
			'appleMail',
			'gmail',
			'outlookDesktop',
			'outlookNew',
			'yahooMail',
		]);
	});

	it('registerClientSimulator → simulateClient dispatches the new simulator', () => {
		const original = clientSimulators.get('gmail')!;
		registerClientSimulator('gmail' as TargetClient, () => 'STUB');
		try {
			expect(simulateClient('<html>x</html>', 'gmail')).toBe('STUB');
		} finally {
			registerClientSimulator('gmail', original);
		}
	});
});

// =============================================================================
// Bucket 2 — Contract: every simulator returns a string for any HTML input
// =============================================================================
describe('clientSimulators — every installed simulator satisfies the ClientSimulator contract', () => {
	for (const [client, simulator] of clientSimulators.entries()) {
		describe(`simulator "${client}"`, () => {
			it('returns a string for any HTML input', () => {
				expect(typeof simulator('')).toBe('string');
				expect(typeof simulator('<html><body>x</body></html>')).toBe('string');
				expect(typeof simulator('<input/>')).toBe('string');
			});

			it('is pure: same input → same output', () => {
				const a = simulator('<p>same</p>');
				const b = simulator('<p>same</p>');
				expect(a).toBe(b);
			});
		});
	}
});

// =============================================================================
// Bucket 3 — Behavior-parity / regression
//
// The legacy simulateClient switch had very specific semantics per client.
// These snapshots lock the post-refactor output to the historical behavior.
// =============================================================================
describe('clientSimulators — behavior parity with the legacy switch', () => {
	const fixture = `<html><head><style>.x{color:red}</style></head><body>
<input name="email"/>
<form><button type="submit">go</button></form>
<div class="hero" style="position:absolute;border-radius:8px;max-width:600px;animation:fadeIn 1s;background-size:cover">
<p>Hello</p>
</div>
</body></html>`;

	it('gmail strips <style>, position, class, input, form', () => {
		const out = simulateClient(fixture, 'gmail');
		expect(out).not.toContain('<style>');
		expect(out).not.toContain('position:');
		expect(out).not.toContain('class="hero"');
		expect(out).toContain('[gmail: input stripped]');
		expect(out).toContain('[gmail: form stripped]');
	});

	it('outlookDesktop strips border-radius, max-width, animation, @media, background-size', () => {
		const out = simulateClient(fixture, 'outlookDesktop');
		expect(out).not.toContain('border-radius:');
		expect(out).not.toContain('max-width:');
		expect(out).not.toContain('animation:');
		expect(out).not.toContain('background-size:');
	});

	it('outlookNew strips only forms and inputs', () => {
		const out = simulateClient(fixture, 'outlookNew');
		expect(out).toContain('[outlook-new: input stripped]');
		expect(out).toContain('[outlook-new: form stripped]');
		// Should NOT strip border-radius / max-width / animation
		expect(out).toContain('border-radius:8px');
	});

	it('yahooMail strips position:absolute and inputs only', () => {
		const out = simulateClient(fixture, 'yahooMail');
		expect(out).not.toContain('position:absolute');
		expect(out).toContain('[yahoo: input stripped]');
		// Forms are preserved
		expect(out).toContain('<form>');
	});

	it('appleMail passes HTML through unchanged', () => {
		expect(simulateClient(fixture, 'appleMail')).toBe(fixture);
	});
});

// =============================================================================
// Bucket 4 — Extension proof: a third-party simulator is dispatched identically
// =============================================================================
describe('clientSimulators — extension proof', () => {
	const installed: TargetClient[] = [];
	afterEach(() => {
		while (installed.length > 0) unregisterClientSimulator(installed.pop()!);
	});

	it('registers a custom simulator and simulateClient invokes it', () => {
		const samsung: ClientSimulator = (html) => html.toUpperCase();
		registerClientSimulator('samsungMail' as TargetClient, samsung);
		installed.push('samsungMail' as TargetClient);

		const out = simulateClient('<p>hello</p>', 'samsungMail' as TargetClient);
		expect(out).toBe('<P>HELLO</P>');
	});

	it('registering an existing client overrides the built-in', () => {
		const original = clientSimulators.get('gmail')!;
		registerClientSimulator('gmail', () => 'overridden');
		try {
			expect(simulateClient('<p>x</p>', 'gmail')).toBe('overridden');
		} finally {
			registerClientSimulator('gmail', original);
		}
	});

	it('unregister restores fall-through (no simulator → pass through)', () => {
		// Save built-in, remove it, assert pass-through, restore it
		const original = clientSimulators.get('gmail')!;
		unregisterClientSimulator('gmail');
		try {
			expect(simulateClient('<p>x</p>', 'gmail')).toBe('<p>x</p>');
		} finally {
			registerClientSimulator('gmail', original);
		}
	});
});

// =============================================================================
// Bucket 5 — Failure modes
// =============================================================================
describe('clientSimulators — failure modes', () => {
	it('unknown clients pass HTML through unchanged', () => {
		const html = '<p>untouched</p>';
		expect(simulateClient(html, 'nonexistent' as TargetClient)).toBe(html);
	});

	it('passes an empty string through every built-in simulator without throwing', () => {
		for (const [, simulator] of clientSimulators.entries()) {
			expect(() => simulator('')).not.toThrow();
		}
	});
});
