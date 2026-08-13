import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Guard for the in-app landing splash (`/`). It is declarative markup with no
 * runtime behaviour to unit-test, so we pin the two things that silently rotted
 * before:
 *  - the copy and tab title claimed "email marketing", a positioning Owlat
 *    outgrew (it is an open-source, self-hosted email PLATFORM — campaigns,
 *    automations, transactional, team inbox, personal mail, own MTA);
 *  - it painted itself with hardcoded palette values (bg-white/85, fixed rgba
 *    auroras), which render as light-mode islands once the app is in dark mode.
 * The auth CTAs are pinned too: this page is the only entry point to
 * login/register for a signed-out visitor.
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '..', 'pages', 'index.vue'), 'utf8');

const styleBlock = source.slice(source.indexOf('<style'));

describe('landing page copy', () => {
	it('titles the tab with the platform positioning, not the old marketing pitch', () => {
		const title = source.match(/title:\s*'([^']+)'/)?.[1] ?? '';
		expect(title).toContain('Owlat');
		expect(title.toLowerCase()).not.toContain('marketing');
	});

	it('pitches the whole stack', () => {
		expect(source).toContain('Send better email.');
		expect(source).toContain('Own the whole stack.');
		expect(source).toMatch(/open-source, self-hosted email platform/);
	});

	it('names the capability spread instead of campaigns alone', () => {
		for (const capability of ['Automations', 'Transactional', 'Team inbox', 'Own MTA']) {
			expect(source).toContain(capability);
		}
	});
});

describe('landing page theming', () => {
	it('uses semantic color tokens, never raw palette utilities', () => {
		const rawPalette =
			/\b(?:bg|text|border|from|to|via)-(?:white|black|gray|slate|zinc|neutral|stone)\b/g;
		expect(source.match(rawPalette) ?? []).toEqual([]);
	});

	it('drives the decorative aurora from tokens, not literal colors', () => {
		expect(styleBlock).not.toMatch(/rgba?\(/);
		expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
		expect(styleBlock).toContain('var(--color-brand-glow)');
	});
});

describe('landing page auth entry points', () => {
	it('keeps the login and register CTAs wired', () => {
		expect(source).toMatch(/to="\/auth\/login"/);
		expect(source).toMatch(/to="\/auth\/register"/);
	});
});
