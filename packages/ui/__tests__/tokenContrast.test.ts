// @vitest-environment node
/**
 * WCAG AA contrast floor for the TEXT tokens, read straight out of light.css
 * and dark.css.
 *
 * A colour token is not a decision anyone re-checks. `--color-warning` shipped
 * at 3.31:1 on the page background — an amber that looked like amber to the
 * person who picked it and was, for a lot of readers, simply faint — and no test
 * could have said so, because "is this readable" was nowhere expressed as a
 * rule. This is that rule: every token whose job is to be READ, paired with the
 * surfaces it is read on, at the 4.5:1 normal-text floor.
 *
 * The pairs are declared rather than exhaustive, and the two exclusions are
 * deliberate:
 *  - `--color-text-disabled` — WCAG exempts inactive controls, and a disabled
 *    field that met the floor would not look disabled.
 *  - `--color-text-inverse` — it is never on the surface ladder; it paints on
 *    solid brand/danger fills, which own their own contrast (see the
 *    --color-error-strong note in tokens.css).
 *  - `--color-bg-deep` is likewise absent from the background set: it is the
 *    substrate the content ladder sits ON (page wells), not a text surface.
 * `--color-brand` is text on links and misses the floor at 3.83:1; raising it is
 * an identity change, tracked in docs/ux-plan/DEFERRALS.md rather than waived
 * silently here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type Rgb = [number, number, number];

/** Every `--token: value;` in a file, last declaration winning. */
function declarations(css: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const match of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
		out.set(match[1]!, match[2]!.trim());
	}
	return out;
}

const light = declarations(
	readFileSync(fileURLToPath(new URL('../assets/css/light.css', import.meta.url)), 'utf8')
);
const dark = declarations(
	readFileSync(fileURLToPath(new URL('../assets/css/dark.css', import.meta.url)), 'utf8')
);

/**
 * Resolve a token to a hex colour, following `var(--other)` chains — the
 * semantic background tokens are aliases onto the surface ladder, so a test that
 * only understood literals would silently skip most of the pairs.
 */
function resolve(tokens: Map<string, string>, name: string, seen = new Set<string>()): string {
	expect(seen.has(name), `circular var() chain at ${name}`).toBe(false);
	seen.add(name);
	const value = tokens.get(name);
	expect(value, `${name} is declared`).toBeDefined();
	const alias = /^var\((--[\w-]+)\)$/.exec(value!.trim());
	if (alias) return resolve(tokens, alias[1]!, seen);
	expect(value, `${name} resolves to a hex literal`).toMatch(/^#[0-9a-fA-F]{6}$/);
	return value!.toLowerCase();
}

function rgb(hex: string): Rgb {
	const n = hex.replace('#', '');
	return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16)) as Rgb;
}

/** WCAG 2.x relative luminance. */
function luminance(color: Rgb): number {
	const [r, g, b] = color.map((channel) => {
		const c = channel / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	}) as Rgb;
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x);
	return (hi! + 0.05) / (lo! + 0.05);
}

/** WCAG 2.2 AA, normal-size text. */
const FLOOR = 4.5;

/** The surfaces body text is rendered on, in both themes. */
const CONTENT_SURFACES = [
	'--color-bg-base',
	'--color-bg-elevated',
	'--color-bg-surface',
	'--color-bg-soft',
];

/** The neutral reading ladder — every one of these is only ever text. */
const TEXT_TOKENS = ['--color-text-primary', '--color-text-secondary', '--color-text-tertiary'];

/**
 * Status colours. Read as words (`text-warning`, `text-success`) far more often
 * than painted as fills, and additionally paired with their own `-subtle` chip
 * background, which is the tightest pairing each one has.
 */
const STATUS_TOKENS = ['--color-success', '--color-warning', '--color-error', '--color-info'];

const THEMES = [
	['light', light],
	['dark', dark],
] as const;

function pairs(tokens: Map<string, string>): Array<[string, string]> {
	const all: Array<[string, string]> = [];
	for (const token of [...TEXT_TOKENS, ...STATUS_TOKENS]) {
		for (const surface of CONTENT_SURFACES) all.push([token, surface]);
	}
	for (const token of STATUS_TOKENS) all.push([token, `${token}-subtle`]);
	// Only pairs both files actually declare — a token renamed on one side
	// should fail the declaration check below, not vanish from this list.
	return all.filter(([token, surface]) => tokens.has(token) && tokens.has(surface));
}

describe.each(THEMES)('%s theme text contrast', (_theme, tokens) => {
	it('declares every token this suite claims to cover', () => {
		const missing = [...TEXT_TOKENS, ...STATUS_TOKENS, ...CONTENT_SURFACES]
			.concat(STATUS_TOKENS.map((token) => `${token}-subtle`))
			.filter((token) => !tokens.has(token));
		expect(missing).toEqual([]);
	});

	// Guards the guard: a resolver that stopped resolving, or a set of constants
	// someone emptied, would turn every assertion below into a silent pass.
	it('has pairs to check at all', () => {
		expect(pairs(tokens).length).toBeGreaterThanOrEqual(28);
	});

	it(`clears ${FLOOR}:1 on every paired background`, () => {
		const failures = pairs(tokens)
			.map(([token, surface]) => ({
				pair: `${token} on ${surface}`,
				ratio: Number(contrast(resolve(tokens, token), resolve(tokens, surface)).toFixed(2)),
			}))
			.filter((entry) => entry.ratio < FLOOR);
		expect(failures).toEqual([]);
	});

	it('resolves a var() alias rather than skipping it', () => {
		// --color-bg-base is `var(--surface-1)` in both themes; if the chain
		// stopped being followed the pairs above would compare nothing.
		expect(resolve(tokens, '--color-bg-base')).toMatch(/^#[0-9a-f]{6}$/);
		expect(resolve(tokens, '--color-bg-base')).toBe(resolve(tokens, '--surface-1'));
	});
});

describe('the token that motivated the floor', () => {
	it('keeps light-mode warning readable rather than decorative', () => {
		// It shipped at 3.31:1 — an amber that reads as a highlight, not a word.
		// Named separately from the table above so a future edit that widened an
		// exclusion could not quietly take this specific pair back out.
		expect(
			contrast(resolve(light, '--color-warning'), resolve(light, '--color-bg-base'))
		).toBeGreaterThanOrEqual(FLOOR);
	});
});
