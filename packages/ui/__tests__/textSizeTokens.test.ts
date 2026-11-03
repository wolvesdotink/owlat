/**
 * text-size.css restates every type step as `calc(<base> * var(--ui-text-scale))`.
 * The bases have to match the scale they scale (Tailwind's ladder and the named
 * steps in tokens.css): a stale base would make one size jump at every text
 * size but 100%. A named step added to tokens.css without a scaled twin would
 * keep its size while the rest grows.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = (path: string) => readFileSync(path, 'utf8');
const textSizeCss = css(resolve(__dirname, '../assets/css/text-size.css'));
const tokensCss = css(resolve(__dirname, '../assets/css/tokens.css'));
const tailwindThemeCss = css(createRequire(import.meta.url).resolve('tailwindcss/theme.css'));

/** `--text-*` declarations with a plain value (`0.75rem`), by name. */
function plainTextTokens(source: string): Map<string, string> {
	const tokens = new Map<string, string>();
	for (const match of source.matchAll(/(--text-[\w-]+):\s*([\d.]+rem);/g)) {
		tokens.set(match[1]!, match[2]!);
	}
	return tokens;
}

const scaled = new Map(
	[
		...textSizeCss.matchAll(/(--text-[\w-]+):\s*calc\(([\d.]+rem) \* var\(--ui-text-scale\)\);/g),
	].map((match) => [match[1]!, match[2]!])
);

describe('text-size.css', () => {
	it('scales each step from the base the scale gives it', () => {
		const bases = new Map([...plainTextTokens(tailwindThemeCss), ...plainTextTokens(tokensCss)]);
		expect(scaled.size).toBeGreaterThan(0);
		for (const [name, base] of scaled) {
			expect({ name, base: bases.get(name) }).toEqual({ name, base });
		}
	});

	it('scales every named step of tokens.css, line heights included', () => {
		for (const name of plainTextTokens(tokensCss).keys()) {
			expect(scaled.has(name), name).toBe(true);
		}
	});

	it('gives every offered text size a scale', () => {
		for (const percent of [90, 110, 120, 130]) {
			expect(textSizeCss).toContain(
				`:root[data-text-size='${percent}'] {\n\t--ui-text-scale: ${percent / 100};`
			);
		}
	});
});
