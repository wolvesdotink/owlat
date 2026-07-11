import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Guard for the branded SPA cold-boot splash (next-layer UX plan, workstream C —
 * native feel: no blank cold-boot window). The splash is declarative markup, so
 * there is nothing to unit-test at runtime; instead we pin the wiring and the
 * self-containment invariants a refactor could silently break:
 *  - it is registered in nuxt.config so a cold launch actually paints it;
 *  - it ships NO external/CDN asset (the CSP forbids them and it loads before
 *    the bundle), so any http(s):// URL, <link>, or <script src> is a defect;
 *  - it handles both themes and honors reduced motion.
 */

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..', '..');

const nuxtConfig = readFileSync(resolve(appRoot, 'nuxt.config.ts'), 'utf8');
const template = readFileSync(resolve(appRoot, 'app', 'spa-loading-template.html'), 'utf8');

// Resolve the FF SSOT stylesheets the splash mirrors. appRoot is apps/web, so
// the shared token css lives up two levels in packages/ui/assets/css.
const cssRoot = resolve(appRoot, '..', '..', 'packages', 'ui', 'assets', 'css');
const ssot = {
	dark: readFileSync(resolve(cssRoot, 'dark.css'), 'utf8'),
	light: readFileSync(resolve(cssRoot, 'light.css'), 'utf8'),
} as const;

/** Read the hex value of a `--token` custom property from an SSOT stylesheet. */
function ssotToken(theme: 'dark' | 'light', token: string): string {
	const escaped = token.replace(/[-]/g, '\\-');
	const match = ssot[theme].match(new RegExp(`${escaped}\\s*:\\s*(#[0-9a-fA-F]{3,8})`));
	if (!match?.[1]) {
		throw new Error(`token ${token} not found in ${theme}.css`);
	}
	return match[1].toLowerCase();
}

// Extract every splash color declaration together with the SSOT token its inline
// comment names — e.g. `--spa-bg: #171717; /* --surface-1 (dark) */` maps the
// value #171717 to token --surface-1 in the dark theme. Each row pins one
// mirrored value to the token + theme it claims to copy.
function mirroredDeclarations(): Array<{ hex: string; token: string; theme: 'dark' | 'light' }> {
	const re = /--spa-[\w-]+:\s*(#[0-9a-fA-F]{3,8});\s*\/\*\s*(--[\w-]+)\s*\((dark|light)\)\s*\*\//g;
	const rows: Array<{ hex: string; token: string; theme: 'dark' | 'light' }> = [];
	for (const m of template.matchAll(re)) {
		const [, hex, token, theme] = m;
		if (hex && token && (theme === 'dark' || theme === 'light')) {
			rows.push({ hex: hex.toLowerCase(), token, theme });
		}
	}
	return rows;
}

describe('SPA loading template — wiring', () => {
	it('is registered as the spaLoadingTemplate in nuxt config', () => {
		expect(nuxtConfig).toContain("spaLoadingTemplate: 'spa-loading-template.html'");
	});
});

describe('SPA loading template — self-contained', () => {
	it('references no external or CDN asset', () => {
		expect(template).not.toMatch(/https?:\/\//i);
		// protocol-relative URLs (//cdn…) — but not CSS comments (`// …`).
		expect(template).not.toMatch(/(?:src|href)\s*=\s*["']\/\//i);
		expect(template).not.toMatch(/<link\b/i);
		expect(template).not.toMatch(/<script\b/i);
		expect(template).not.toMatch(/url\(\s*["']?https?:/i);
	});

	it('inlines the logo mark and its styles', () => {
		expect(template).toMatch(/<svg\b/i);
		expect(template).toMatch(/<path\b/i);
		expect(template).toMatch(/<style>/i);
	});
});

describe('SPA loading template — themes and motion', () => {
	it('resolves both themes via prefers-color-scheme', () => {
		expect(template).toContain('@media (prefers-color-scheme: light)');
	});

	it('honors reduced motion', () => {
		expect(template).toContain('@media (prefers-reduced-motion: reduce)');
	});
});

describe('SPA loading template — FF token parity', () => {
	const rows = mirroredDeclarations();

	it('mirrors a value for each theme', () => {
		// dark defaults + light overrides = 3 tokens × 2 themes.
		expect(rows.filter((r) => r.theme === 'dark')).toHaveLength(3);
		expect(rows.filter((r) => r.theme === 'light')).toHaveLength(3);
	});

	it('each mirrored hex equals its named FF SSOT token, per theme', () => {
		for (const { hex, token, theme } of rows) {
			expect(hex, `${token} (${theme})`).toBe(ssotToken(theme, token));
		}
	});
});
