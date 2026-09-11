import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WCAG AA contrast floor for the TEXT tokens, read straight out of light.css
 * and dark.css.
 *
 * A colour token is not a decision anyone re-checks. `--color-warning` shipped
 * at 3.31:1 on the page background — an amber that looked like amber to the
 * person who picked it and was, for a lot of readers, simply faint — and
 * nothing could have said so, because "is this readable" was nowhere expressed
 * as a rule. This is that rule: every token whose job is to be READ, paired
 * with the surfaces it is read on, at the 4.5:1 normal-text floor.
 *
 * Sibling of check-palette-classes.ts and run from the same `lint:tokens` gate:
 * that one keeps the app painted from the tokens, this one keeps the tokens
 * legible. Both are seams oxlint cannot express.
 *
 * The pairs are declared rather than exhaustive, and the exclusions are
 * deliberate:
 *  - `--color-text-disabled` — WCAG exempts inactive controls, and a disabled
 *    field that met the floor would not look disabled.
 *  - `--color-text-inverse` — it is never on the surface ladder; it paints on
 *    solid brand/danger fills, which own their own contrast (see the
 *    --color-error-strong note in tokens.css).
 *  - `--color-bg-deep` — the substrate the content ladder sits ON (page wells),
 *    not a text surface.
 * `--color-brand` is text on links and misses the floor at 3.83:1; raising it
 * is an identity change, tracked in docs/ux-plan/DEFERRALS.md rather than
 * waived silently here.
 */

const workspace = join(import.meta.dirname, '..');
const cssDir = join(workspace, 'packages', 'ui', 'assets', 'css');

type Rgb = [number, number, number];

/** Every `--token: value;` in a file, last declaration winning. */
function declarations(css: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const match of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
		out.set(match[1]!, match[2]!.trim());
	}
	return out;
}

const problems: string[] = [];

/**
 * Resolve a token to a hex colour, following `var(--other)` chains — the
 * semantic background tokens are aliases onto the surface ladder, so a resolver
 * that only understood literals would silently skip most of the pairs. Returns
 * null and records the reason when the chain does not end in a hex literal.
 */
function resolve(
	theme: string,
	tokens: Map<string, string>,
	name: string,
	seen = new Set<string>()
): string | null {
	if (seen.has(name)) {
		problems.push(`${theme}: circular var() chain at ${name}`);
		return null;
	}
	seen.add(name);
	const value = tokens.get(name);
	if (value === undefined) {
		problems.push(`${theme}: ${name} is not declared`);
		return null;
	}
	const alias = /^var\((--[\w-]+)\)$/.exec(value);
	if (alias) return resolve(theme, tokens, alias[1]!, seen);
	if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
		problems.push(`${theme}: ${name} resolves to ${value}, not a 6-digit hex literal`);
		return null;
	}
	return value.toLowerCase();
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
	return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
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

/**
 * The pair count each theme must produce. Guards the guard: a resolver that
 * stopped resolving, or a constant list someone emptied, would otherwise turn
 * the whole scan into a silent pass.
 */
const EXPECTED_PAIRS =
	(TEXT_TOKENS.length + STATUS_TOKENS.length) * CONTENT_SURFACES.length + STATUS_TOKENS.length;

for (const theme of ['light', 'dark']) {
	const tokens = declarations(readFileSync(join(cssDir, `${theme}.css`), 'utf8'));

	const pairs: Array<[string, string]> = [];
	for (const token of [...TEXT_TOKENS, ...STATUS_TOKENS]) {
		for (const surface of CONTENT_SURFACES) pairs.push([token, surface]);
	}
	for (const token of STATUS_TOKENS) pairs.push([token, `${token}-subtle`]);

	if (pairs.length !== EXPECTED_PAIRS) {
		problems.push(`${theme}: built ${pairs.length} pairs, expected ${EXPECTED_PAIRS}`);
	}

	for (const [token, surface] of pairs) {
		const fg = resolve(theme, tokens, token);
		const bg = resolve(theme, tokens, surface);
		if (fg === null || bg === null) continue;
		const ratio = contrast(fg, bg);
		if (ratio < FLOOR) {
			problems.push(
				`${theme}: ${token} on ${surface} is ${ratio.toFixed(2)}:1, below the ${FLOOR}:1 floor`
			);
		}
	}

	// --color-bg-base is `var(--surface-1)` in both themes; if the chain stopped
	// being followed every pair above would compare a token against itself.
	const base = resolve(theme, tokens, '--color-bg-base');
	if (base !== null && base !== resolve(theme, tokens, '--surface-1')) {
		problems.push(`${theme}: --color-bg-base no longer aliases --surface-1`);
	}
}

if (problems.length > 0) {
	console.error(
		`Text tokens below the WCAG AA ${FLOOR}:1 floor in packages/ui/assets/css. A token whose job\nis to be read has to be readable on every surface it is read on — pick a darker\n(light theme) or lighter (dark theme) value, or, if the pairing genuinely never\nhappens, take it out of the declared set in scripts/check-token-contrast.ts and\nsay why:`
	);
	console.error(problems.map((problem) => `  ${problem}`).join('\n'));
	process.exit(1);
}

console.log(
	`ok:   ${EXPECTED_PAIRS * 2} text/surface token pairs clear the WCAG AA ${FLOOR}:1 floor`
);
