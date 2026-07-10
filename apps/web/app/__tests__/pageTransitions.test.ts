import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Config/markup guard for the app-wide page transitions + route-progress
 * indicator (next-layer UX plan, workstream C — native feel everywhere).
 *
 * These pieces are declarative (Nuxt config + a CSS name-based transition + a
 * built-in component), so there is no pure logic to unit-test — instead we pin
 * the wiring so a refactor can't silently drop the transition, the reduced-
 * motion branch, or the loading indicator.
 */

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..', '..');

const nuxtConfig = readFileSync(resolve(appRoot, 'nuxt.config.ts'), 'utf8');
const appVue = readFileSync(resolve(appRoot, 'app', 'app.vue'), 'utf8');
const transitionsCss = readFileSync(
	resolve(appRoot, 'app', 'assets', 'css', 'page-transitions.css'),
	'utf8'
);
const mainCss = readFileSync(resolve(appRoot, 'app', 'assets', 'css', 'main.css'), 'utf8');

describe('page transitions — nuxt config', () => {
	it('enables named page + layout transitions in out-in mode', () => {
		expect(nuxtConfig).toContain("pageTransition: { name: 'page', mode: 'out-in' }");
		expect(nuxtConfig).toContain("layoutTransition: { name: 'layout', mode: 'out-in' }");
	});
});

describe('route-progress indicator — app.vue', () => {
	it('renders a NuxtLoadingIndicator tinted with the FF brand token', () => {
		expect(appVue).toContain('<NuxtLoadingIndicator');
		expect(appVue).toContain('color="var(--color-brand)"');
	});
});

describe('page transitions — stylesheet', () => {
	it('is wired into the app stylesheet', () => {
		expect(mainCss).toContain("@import './page-transitions.css';");
	});

	it('drives the transition entirely from shared FF motion tokens (no hardcoded timing)', () => {
		expect(transitionsCss).toContain('var(--motion-moderate)');
		expect(transitionsCss).toContain('var(--ease-spring)');
		expect(transitionsCss).toContain('var(--ease-exit)');
		// No raw millisecond/second durations or hand-rolled cubic-beziers.
		expect(transitionsCss).not.toMatch(/transition:[^;]*\b\d+m?s\b/);
		expect(transitionsCss).not.toContain('cubic-bezier(');
	});

	it('defines the page + layout enter/leave states', () => {
		for (const cls of [
			'.page-enter-active',
			'.page-leave-active',
			'.page-enter-from',
			'.page-leave-to',
			'.layout-enter-active',
			'.layout-leave-active',
		]) {
			expect(transitionsCss).toContain(cls);
		}
	});

	it('honors prefers-reduced-motion with an instant, static swap', () => {
		expect(transitionsCss).toContain('@media (prefers-reduced-motion: reduce)');
		const reducedBlock = transitionsCss.slice(
			transitionsCss.indexOf('@media (prefers-reduced-motion: reduce)')
		);
		expect(reducedBlock).toContain('transition: none;');
		expect(reducedBlock).toContain('transform: none;');
	});
});
