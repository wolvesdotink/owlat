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
