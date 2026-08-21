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

/**
 * A page body: no landmarks, no heading, and a link but no way to skip past the
 * chrome to it (`bypass` only applies to a page that has links at all).
 */
const Unlandmarked = defineComponent({
	template: '<div><p>Content with nowhere to live.</p><a href="/dashboard">Dashboard</a></div>',
});

/** What a layout is supposed to give the document. */
const Page = defineComponent({
	template: `
		<div>
			<a href="#main-content">Skip to main content</a>
			<nav aria-label="Primary"><a href="/dashboard">Dashboard</a></nav>
			<main id="main-content"><h1>Title</h1></main>
		</div>
	`,
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

	it('holds a page-scope mount to the document rules a fragment is exempt from', async () => {
		// A page body is judged on its own chrome: its landmarks live in the
		// layout, so these rules stay quiet…
		expect(await auditA11y(Unlandmarked)).toEqual([]);
		// …and a layout, which is where they do live, is judged on them.
		const rules = (await auditA11y(Unlandmarked, { pageContext: true })).map(
			(line) => line.split(' ')[0]
		);
		expect(rules).toContain('region');
		expect(rules).toContain('landmark-one-main');
		expect(rules).toContain('page-has-heading-one');
		expect(rules).toContain('bypass');
	});

	it('passes a page that carries its landmarks, its h1 and its skip link', async () => {
		expect(await auditA11y(Page, { pageContext: true })).toEqual([]);
	});

	it('fails loudly when the UI layer did not resolve, instead of auditing nothing', async () => {
		const Renamed = defineComponent({ template: '<div><UiRenamedInput /></div>' });
		await expect(auditA11y(Renamed)).rejects.toThrow('UiRenamedInput');
	});
});
