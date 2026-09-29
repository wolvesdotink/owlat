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
 *  - `min-h-screen` measures the tallest viewport, so mobile browser chrome
 *    clipped the centred cards;
 *  - the framed email is attacker-influenced HTML and must never run scripts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const pageNames = ['archive', 'share', 'unsubscribe', 'confirm', 'preferences'] as const;

const pages = Object.fromEntries(
	pageNames.map((name) => [name, readFileSync(resolve(here, '..', 'pages', `${name}.vue`), 'utf8')])
) as Record<(typeof pageNames)[number], string>;

/** The shared pieces the pages draw their states and the framed email with. */
const partNames = ['RecipientStateCard', 'PublicEmailFrame'] as const;
const parts = Object.fromEntries(
	partNames.map((name) => [
		name,
		readFileSync(resolve(here, '..', 'components', 'recipient', `${name}.vue`), 'utf8'),
	])
) as Record<(typeof partNames)[number], string>;
const sources: Record<string, string> = { ...pages, ...parts };
const sourceNames = [...pageNames, ...partNames];

/** The card-shaped pages: brand header, one card, one action, footer. */
const cardPages = ['unsubscribe', 'confirm', 'preferences'] as const;
/** The two pages that frame an email in a sandboxed iframe. */
const framePages = ['archive', 'share'] as const;

describe('recipient pages follow the recipient color scheme', () => {
	it.each(sourceNames)('%s paints itself with semantic tokens only', (name) => {
		const rawPalette =
			/\b(?:bg|text|border|from|to|via)-(?:white|black|gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)\b/g;
		expect(sources[name]!.match(rawPalette) ?? []).toEqual([]);
	});

	it.each(sourceNames)('%s carries no hardcoded color literals', (name) => {
		expect(sources[name]).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
		expect(sources[name]).not.toMatch(/\brgba?\(/);
	});

	it.each(sourceNames)(
		'%s leaves the mode switch to the token layer, not dark: variants',
		(name) => {
			// The tokens re-resolve on `.dark`; a `dark:` utility on top of them is a
			// second, divergent source of truth for the same pixel.
			expect(sources[name]).not.toMatch(/\bdark:/);
		}
	);
});

describe('recipient pages are mobile-first', () => {
	it.each(pageNames)('%s sizes itself to the dynamic viewport', (name) => {
		expect(pages[name]).toContain('min-h-dvh');
		// min-h-screen is the LARGE viewport: on mobile Safari/Chrome the collapsed
		// browser chrome then pushes the centred content out of the visual viewport.
		expect(pages[name]).not.toContain('min-h-screen');
	});

	it.each(cardPages)('%s wraps the unbounded contact strings', (name) => {
		// Contact emails and organization names are arbitrary length and the card
		// is read at 320px; without this they push the card wider than the screen.
		expect(pages[name]).toContain('break-words');
	});

	it.each(framePages)('%s wraps the unbounded sender line', (name) => {
		expect(pages[name]).toContain('break-words');
	});

	it('the email frame wraps the unbounded subject line', () => {
		expect(parts.PublicEmailFrame).toMatch(/<h1[^>]*break-words/);
	});
});

describe('framed email stays readable and sandboxed', () => {
	it.each(framePages)(
		'%s frames the email through PublicEmailFrame, not its own iframe',
		(name) => {
			// One component owns the sandbox policy for public pages.
			expect(pages[name]).toContain('<PublicEmailFrame');
			expect(pages[name]).not.toContain('<iframe');
		}
	);

	it('never lets the untrusted email run scripts', () => {
		// same-origin + scripts = full escape from the sandbox, and this frame
		// renders attacker-influenced HTML.
		expect(parts.PublicEmailFrame).toContain('sandbox="allow-same-origin"');
		// The attribute, not the source: the comment above the frame names
		// `allow-scripts` precisely to say it must never be added.
		expect(parts.PublicEmailFrame).not.toMatch(/sandbox="[^"]*allow-scripts/);
	});

	it('names the frame for screen readers', () => {
		expect(parts.PublicEmailFrame).toMatch(/<iframe[\s\S]*?:title="[^"]+"/);
		for (const name of framePages) expect(pages[name]).toMatch(/:frame-title="[^"]+"/);
	});
});

describe('recipient pages are headed by the sender, not the platform', () => {
	it.each(cardPages)('%s never uses "Owlat" as its heading', (name) => {
		// The recipient knows the sender, not Owlat; "Owlat" as the heading of an
		// unsubscribe page reads like phishing. Owlat is the footer credit only.
		expect(pages[name]).not.toMatch(/<h1[^>]*>\s*Owlat\s*<\/h1>/);
		expect(pages[name]).toContain('<RecipientHeader');
		expect(pages[name]).toContain('<RecipientFooter');
	});

	it.each(cardPages)('%s offers the sender address when the link fails', (name) => {
		expect(pages[name]).toContain('<RecipientContactHint');
	});
});
