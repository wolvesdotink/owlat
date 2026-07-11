/**
 * Accessibility contract for the interactive rows that used to be mouse-only
 * <div @click> / <tr @click> elements on the delivery (domains, webhooks) and
 * send (marketing, transactional) pages. Those elements are now exposed to
 * assistive tech and the keyboard as real buttons: focusable (tabindex="0"),
 * announced (role="button"), operable with Enter and Space, and — for the
 * expandable delivery rows — reflecting open/closed state via aria-expanded.
 *
 * This gate reads the REAL shipped templates (not fabricated copies) and pins
 * the exact interactive markup, so a regression to a bare <div @click>
 * (keyboard-unreachable) fails CI. The webhooks/marketing/transactional rows are
 * inline in their Convex-backed Nuxt `pages/` components; the domains row markup
 * now lives in its extracted `components/domains/RecordRow.vue` sub-component.
 * Either way, mounting the surface in isolation would require stubbing the
 * entire Convex/Nuxt/UI surface, so we assert against the source of truth
 * directly. Each container's keydown handlers are additionally
 * required to carry the `.self` modifier: without it, activating a nested
 * action button with the keyboard would bubble up and ALSO fire the row/card
 * default action, violating the "activating a row never fires a nested action"
 * contract. The pages deliberately nest interactive controls (proven below via
 * @click.stop), which is exactly why `.self` is load-bearing here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const domainsRow = read('../components/domains/RecordRow.vue');
const webhooks = read('../pages/dashboard/delivery/webhooks.vue');
const marketing = read('../pages/dashboard/send/marketing/index.vue');
const transactional = read('../pages/dashboard/send/transactional/index.vue');
const commandRowReference = read('../components/campaigns/CommandRow.vue');

/** Every opening tag in `src` whose attribute list contains `marker`. */
function tagsWith(src: string, marker: string): string[] {
	const tags: string[] = [];
	let idx = src.indexOf(marker);
	while (idx !== -1) {
		const start = src.lastIndexOf('<', idx);
		const end = src.indexOf('>', idx);
		if (start === -1 || end === -1) break;
		tags.push(src.slice(start, end + 1));
		idx = src.indexOf(marker, end);
	}
	return tags;
}

/** The single `<tagName …>` opening tag that carries `marker`. */
function pick(src: string, marker: string, tagName: string): string {
	const matches = tagsWith(src, marker).filter((t) => t.startsWith(`<${tagName}`));
	expect(
		matches.length,
		`expected exactly one <${tagName}> carrying \`${marker}\`, found ${matches.length}`
	).toBe(1);
	return matches[0]!;
}

/** Assert a container tag is a keyboard-operable, non-bubbling activation surface. */
function expectActivationContainer(tag: string) {
	expect(tag).toMatch(/role="button"/);
	expect(tag).toMatch(/tabindex="0"/);
	// Operable by keyboard, mirroring components/campaigns/CommandRow.vue.
	expect(tag).toMatch(/@keydown\.enter\.self=/);
	expect(tag).toMatch(/@keydown\.space\.self\.prevent=/);
	// `.self` is what prevents a nested control's keyboard activation from also
	// firing this handler — a bare @keydown.enter would reintroduce the defect.
	expect(tag).not.toMatch(/@keydown\.enter="/);
	// Enter has no default on these elements, so `.prevent` on it is inert; the
	// reference pattern omits it.
	expect(tag).not.toMatch(/@keydown\.enter\.prevent/);
}

/** Assert an expandable header additionally reflects and links its panel. */
function expectExpandableHeader(tag: string, panelIdPrefix: string) {
	expectActivationContainer(tag);
	expect(tag).toMatch(/:aria-expanded=/);
	// `:aria-controls="` followed by a backtick-delimited dynamic id.
	expect(tag).toContain(':aria-controls="' + '`' + panelIdPrefix);
	expect(tag).toMatch(/:aria-label=/);
}

describe('delivery expandable rows are keyboard-operable', () => {
	it('domains: header is a labelled, non-bubbling toggle linked to its DNS panel', () => {
		const header = pick(domainsRow, '@click="emit(\'toggle\')"', 'div');
		expectExpandableHeader(header, 'domain-records-');
		// Panel is programmatically linked back to the header.
		expect(domainsRow).toContain(':id="' + '`' + 'domain-records-');
		// The nested Remove control is named for screen readers, and nesting is
		// real (@click.stop) — which is why the header keydown must be `.self`.
		expect(domainsRow).toMatch(/aria-label="Remove domain"/);
		expect(domainsRow).toMatch(/@click\.stop=/);
	});

	it('webhooks: header is a labelled, non-bubbling toggle linked to its detail panel', () => {
		const header = pick(webhooks, '@click="toggleExpanded(webhook._id)"', 'div');
		expectExpandableHeader(header, 'webhook-details-');
		expect(webhooks).toContain(':id="' + '`' + 'webhook-details-');
	});
});

describe('send template cards and rows are keyboard-operable', () => {
	it('marketing: both the grid card and the list row activate without bubbling', () => {
		expectActivationContainer(pick(marketing, '@click="handleEdit(template._id)"', 'UiCard'));
		expectActivationContainer(pick(marketing, '@click="handleEdit(template._id)"', 'tr'));
		// Nested action controls exist (overlay + row buttons) with @click.stop —
		// `.self` on the containers keeps their keyboard activation isolated.
		expect(marketing).toMatch(/@click\.stop=/);
	});

	it('transactional: both the grid card and the list row activate without bubbling', () => {
		expectActivationContainer(pick(transactional, '@click="handleEdit(email._id)"', 'UiCard'));
		expectActivationContainer(pick(transactional, '@click="handleEdit(email._id)"', 'tr'));
		expect(transactional).toMatch(/@click\.stop=/);
		// Icon-only controls that relied on `title` alone are now labelled.
		expect(transactional).toMatch(/aria-label="View API Code"/);
		expect(transactional).toMatch(/aria-label="Edit"/);
	});
});

describe('custom sort dropdowns expose listbox semantics linked to their trigger', () => {
	const cases = [
		{ name: 'marketing', src: marketing, id: 'marketing-sort-listbox' },
		{ name: 'transactional', src: transactional, id: 'transactional-sort-listbox' },
	];

	for (const { name, src, id } of cases) {
		it(`${name}: trigger and listbox are aria-linked with per-option state`, () => {
			const trigger = pick(src, 'aria-haspopup="listbox"', 'button');
			expect(trigger).toMatch(/:aria-expanded=/);
			expect(trigger).toContain(`aria-controls="${id}"`);

			const listbox = pick(src, 'role="listbox"', 'div');
			expect(listbox).toContain(`id="${id}"`);

			// Options announce their selected state.
			const option = pick(src, 'role="option"', 'button');
			expect(option).toMatch(/:aria-selected=/);
		});
	}
});

describe('parity with the components/campaigns/CommandRow.vue reference', () => {
	it('the reference activates on Enter without .prevent', () => {
		expect(commandRowReference).toMatch(/@keydown\.enter="/);
		expect(commandRowReference).not.toMatch(/@keydown\.enter\.prevent/);
	});

	it('no changed page reintroduces the inert @keydown.enter.prevent', () => {
		for (const src of [domainsRow, webhooks, marketing, transactional]) {
			expect(src).not.toMatch(/@keydown\.enter\.prevent/);
		}
	});
});
