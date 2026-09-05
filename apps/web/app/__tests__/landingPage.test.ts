import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import en from '~~/i18n/locales/en.json';

/**
 * Guard for the in-app landing splash (`/`). It is declarative markup with no
 * runtime behaviour to unit-test, so we pin the two things that silently rotted
 * before:
 *  - the copy and tab title claimed "email marketing", a positioning Owlat
 *    outgrew (it is an open-source, self-hosted email PLATFORM — campaigns,
 *    automations, transactional, team inbox, personal mail, own MTA);
 *  - it painted itself with hardcoded palette values (bg-white/85, fixed rgba
 *    auroras), which render as light-mode islands once the app is in dark mode.
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '..', 'pages', 'index.vue'), 'utf8');

// The decoration itself lives in the shared landing stylesheet (the same one
// AuthShell and the setup flow paint from), two levels up in packages/ui.
const landingCss = readFileSync(
	resolve(here, '..', '..', '..', '..', 'packages', 'ui', 'assets', 'css', 'landing.css'),
	'utf8'
);

/**
 * The copy itself moved into the message catalog, so it is asserted there and
 * the page is asserted to still ASK for it: a keypath the page stopped
 * rendering would leave the catalog perfect and the splash blank, and copy
 * edited back to the old pitch would leave the page perfect and the positioning
 * wrong. `home` is the catalog's landing-page namespace.
 */
const home = en.home;

describe('landing page copy', () => {
	it('titles the tab with the platform positioning, not the old marketing pitch', () => {
		// `<Page> — Owlat` is the convention every other page in the app follows.
		expect(home.pageTitle).toMatch(/ — Owlat$/);
	});

	it('pitches the whole stack', () => {
		expect(source).toContain("t('home.hero.title')");
		expect(source).toContain("t('home.hero.titleAccent')");
		expect(source).toContain("t('home.hero.tagline')");
		expect(home.hero.tagline).toMatch(/open-source, self-hosted email platform/);
	});

	it('names the capability spread instead of campaigns alone', () => {
		expect(source).toMatch(/v-for="\(capability, index\) in capabilities"/);
		const named = Object.values(home.capabilities);
		for (const capability of ['Automations', 'Transactional', 'Team inbox', 'Own MTA']) {
			expect(named).toContain(capability);
		}
		// Every capability the catalog names is one the page actually lists.
		for (const key of Object.keys(home.capabilities)) {
			expect(source).toContain(`t('home.capabilities.${key}')`);
		}
	});
});

const COLOR_UTILITIES = 'bg|text|border|from|via|to|ring|outline|divide|fill|stroke|decoration';
const TAILWIND_PALETTE = [
	'white',
	'black',
	'slate',
	'gray',
	'zinc',
	'neutral',
	'stone',
	'red',
	'orange',
	'amber',
	'yellow',
	'lime',
	'green',
	'emerald',
	'teal',
	'cyan',
	'sky',
	'blue',
	'indigo',
	'violet',
	'purple',
	'fuchsia',
	'pink',
	'rose',
].join('|');

describe('landing page theming', () => {
	it('uses semantic color tokens, never raw palette utilities', () => {
		// Both escapes from the token layer are caught: a palette scale
		// (`bg-slate-800`) and an arbitrary value (`text-[#111]`). Either one
		// freezes a color that then ignores the .dark flip.
		const rawPalette = new RegExp(
			String.raw`\b(?:${COLOR_UTILITIES})-(?:(?:${TAILWIND_PALETTE})\b|\[)`,
			'g'
		);
		expect(source.match(rawPalette) ?? []).toEqual([]);
	});

	it('reuses the shared hero field instead of forking a scoped copy of it', () => {
		expect(source).toContain('<UiHeroField />');
	});

	it('drives the shared decorative aurora from tokens, not literal colors', () => {
		expect(landingCss).not.toMatch(/rgba?\(/);
		expect(landingCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
		expect(landingCss).toContain('var(--color-brand-glow)');
	});
});
