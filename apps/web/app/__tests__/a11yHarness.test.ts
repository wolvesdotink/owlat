// @vitest-environment happy-dom
/**
 * THE HARNESS'S OWN GUARD.
 *
 * Every suite built on `auditA11y` asserts an EMPTY result, so a harness that
 * silently scanned the wrong node — a detached container, an unmounted tree, a
 * misspelled rule id that disabled everything — would turn the whole
 * accessibility layer green and stay that way. These cases pin the two halves
 * of that: it finds what it must find, and it stays quiet about what happy-dom
 * cannot judge.
 */
import { describe, expect, it } from 'vitest';
import { defineComponent } from 'vue';
import { auditA11y } from './a11y';

const Offender = defineComponent({
	template: `
		<div>
			<button></button>
			<img src="/logo.png">
			<input type="text">
		</div>
	`,
});

const Clean = defineComponent({
	template: `
		<div>
			<h1>Title</h1>
			<button aria-label="Dismiss"></button>
			<img src="/logo.png" alt="Owlat">
			<label for="email">Email</label>
			<input id="email" type="text">
			<p style="color: #777; background: #888">Unreadable, but not judgeable here.</p>
		</div>
	`,
});

/** The shape every dialog in the app takes: markup parked outside the mount. */
const TeleportedOffender = defineComponent({
	template: '<Teleport to="body"><div role="dialog"><button></button></div></Teleport>',
});

describe('a11y harness', () => {
	it('follows a dialog that teleports out of the mount', async () => {
		const violations = await auditA11y(TeleportedOffender);
		expect(violations.map((line) => line.split(' ')[0])).toContain('button-name');
	});

	it('reports the nameless control, the alt-less image and the unlabelled field', async () => {
		const violations = await auditA11y(Offender);
		const rules = violations.map((line) => line.split(' ')[0]);
		expect(rules).toContain('button-name');
		expect(rules).toContain('image-alt');
		expect(rules).toContain('label');
	});

	it('names the offending markup in the failure line, not just the rule', async () => {
		const [first] = await auditA11y(Offender);
		expect(first).toContain('<button>');
	});

	it('passes clean markup, and does not guess at contrast it cannot compute', async () => {
		expect(await auditA11y(Clean)).toEqual([]);
	});
});
