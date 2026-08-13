import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Guards for the five recipient-facing pages. They are opened from an email
 * client, on a phone, by someone who never chose Owlat and will never see the
 * dashboard — so they are the whole product to that person and have no second
 * chance. They are also declarative markup with no behaviour worth mounting,
 * so what is pinned here is what silently rotted:
 *  - share/archive painted themselves with hardcoded palette classes
 *    (bg-gray-50, text-gray-900, bg-white), which render as a light-mode island
 *    when the recipient's device is in dark mode;
 *  - the framed email is the one thing that must NOT follow that preference —
 *    campaign HTML is authored for a light canvas, so the paper is pinned light
 *    in both modes or dark-on-dark text becomes unreadable;
 *  - `min-h-screen` measures the tallest viewport, so mobile browser chrome
 *    clipped the centred cards;
 *  - the only control on the page has to be thumb-sized (>= 44px).
 */

const here = dirname(fileURLToPath(import.meta.url));
const pageNames = ['archive', 'share', 'unsubscribe', 'confirm', 'preferences'] as const;

const pages = Object.fromEntries(
	pageNames.map((name) => [name, readFileSync(resolve(here, '..', 'pages', `${name}.vue`), 'utf8')])
) as Record<(typeof pageNames)[number], string>;

/** The card-shaped pages: brand header, one card, one action, footer. */
const cardPages = ['unsubscribe', 'confirm', 'preferences'] as const;
/** The two pages that frame an email in a sandboxed iframe. */
const framePages = ['archive', 'share'] as const;

describe('recipient pages follow the recipient color scheme', () => {
	it.each(pageNames)('%s paints itself with semantic tokens only', (name) => {
		const rawPalette =
			/\b(?:bg|text|border|from|to|via)-(?:white|black|gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)\b/g;
		expect(pages[name].match(rawPalette) ?? []).toEqual([]);
	});

	it.each(pageNames)('%s carries no hardcoded color literals', (name) => {
		expect(pages[name]).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
		expect(pages[name]).not.toMatch(/\brgba?\(/);
	});

	it.each(pageNames)('%s leaves the mode switch to the token layer, not dark: variants', (name) => {
		// The tokens re-resolve on `.dark`; a `dark:` utility on top of them is a
		// second, divergent source of truth for the same pixel.
		expect(pages[name]).not.toMatch(/\bdark:/);
	});
});

describe('recipient pages are mobile-first', () => {
	it.each(pageNames)('%s sizes itself to the dynamic viewport', (name) => {
		expect(pages[name]).toContain('min-h-dvh');
		// min-h-screen is the LARGE viewport: on mobile Safari/Chrome the collapsed
		// browser chrome then pushes the centred content out of the visual viewport.
		expect(pages[name]).not.toContain('min-h-screen');
	});

	it.each(cardPages)('%s keeps its content clear of the notch and home indicator', (name) => {
		expect(pages[name]).toContain('pt-[max(2.5rem,env(safe-area-inset-top))]');
		expect(pages[name]).toContain('pb-[max(2.5rem,env(safe-area-inset-bottom))]');
	});

	it.each(framePages)('%s keeps its chrome clear of the notch and home indicator', (name) => {
		expect(pages[name]).toContain('pt-[env(safe-area-inset-top)]');
		expect(pages[name]).toContain('pb-[max(1.5rem,env(safe-area-inset-bottom))]');
	});

	it.each(cardPages)('%s wraps the unbounded contact strings', (name) => {
		// Contact emails and organization names are arbitrary length and the card
		// is read at 320px; without this they push the card wider than the screen.
		expect(pages[name]).toContain('break-words');
	});

	it.each(framePages)('%s wraps the unbounded subject line', (name) => {
		expect(pages[name]).toContain('break-words');
	});
});

describe('recipient pages have thumb-sized controls', () => {
	it.each(cardPages)('%s sizes its primary action past 44px', (name) => {
		// UiButton's default height is below the 44px touch minimum; h-12 = 48px.
		expect(pages[name]).toMatch(/<UiButton[\s\S]*?class="h-12"/);
	});

	it('preferences expands the switch hit area to 44px without growing the track', () => {
		// UiSwitch's track is 44x24 — wide enough, 20px too short. The rows are the
		// entire job of this page on a phone.
		expect(pages.preferences).toContain(".pref-row :deep(button[role='switch'])::after");
		expect(pages.preferences).toMatch(/inset:\s*-10px\s+-8px/);
		// The rule only reaches switches that sit in a tagged row.
		expect(pages.preferences.match(/class="pref-row|pref-row /g)?.length ?? 0).toBeGreaterThan(1);
	});

	it('preferences keeps its rows visible against the card', () => {
		// `.card` is surface-2 and bg-bg-elevated resolves to surface-2 in BOTH
		// modes, so the rows used to be the exact colour of their parent.
		// Matched inside a class attribute: both names are also named in the
		// comment that explains the choice.
		expect(pages.preferences).not.toMatch(/class="[^"]*\bbg-bg-elevated\b/);
		expect(pages.preferences).toMatch(/class="[^"]*\bbg-bg-surface\b/);
	});
});

describe('framed email stays readable and sandboxed', () => {
	it.each(framePages)('%s pins the email canvas to light in both modes', (name) => {
		// The email HTML brings its own light-canvas colours; inverting the paper
		// with the app would leave dark text on a dark background.
		expect(pages[name]).toContain('class="light bg-surface-3"');
		expect(pages[name]).toContain('scheme-only-light');
	});

	it.each(framePages)('%s never lets the untrusted email run scripts', (name) => {
		// same-origin + scripts = full escape from the sandbox, and this frame
		// renders attacker-influenced HTML.
		expect(pages[name]).toContain('sandbox="allow-same-origin"');
		// The attribute, not the source: the comment above the frame names
		// `allow-scripts` precisely to say it must never be added.
		expect(pages[name]).not.toMatch(/sandbox="[^"]*allow-scripts/);
	});

	it.each(framePages)('%s names the frame for screen readers', (name) => {
		expect(pages[name]).toMatch(/<iframe[\s\S]*?title="[^"]+"/);
	});
});
