/**
 * EVERY LOOPING ANIMATION HAS TO HAVE AN OFF SWITCH.
 *
 * `animate-spin` and `animate-pulse` are the only two infinite animations this
 * product paints, and they are everywhere: a spinner on almost every button
 * that talks to the backend, a pulsing skeleton behind almost every list. For
 * someone with a vestibular disorder that is not a decoration, it is a page
 * that cannot be looked at — and `prefers-reduced-motion` is the setting they
 * have already turned on to say so. Tailwind honours it only when a
 * `motion-reduce:` variant asks it to.
 *
 * A SOURCE lint rather than a rendered assertion, deliberately: the property is
 * about the class strings themselves, there are nearly two hundred of them, and
 * mounting every component that can show a spinner (each in its loading state)
 * is not a test anyone would keep passing. The tradeoff is the usual one for a
 * grep — it cannot see a class assembled at runtime out of fragments — so the
 * counter-check at the bottom fails if the scan stops finding anything, which
 * is how a broken glob would otherwise pass silently.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * The roots that paint app chrome. `packages/ui` is in scope because its
 * components render inside these same pages from the same token block — a
 * spinner is no less unreadable for living in a layer.
 */
const ROOTS = ['apps/web/app', 'packages/ui/components', 'packages/email-builder/src'];

/** The two infinite animations. Anything finite is a transition, not a loop. */
const LOOPING_ANIMATION = /animate-(?:spin|pulse)/;
/** What turns the loop off for someone who asked for less motion. */
const OPT_OUT = 'motion-reduce:animate-none';

const SKIP_DIRS = new Set(['node_modules', '__tests__', 'dist', '.nuxt', '.output']);

function vueFilesUnder(root: string): string[] {
	const absolute = join(repoRoot, root);
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			if (SKIP_DIRS.has(entry)) continue;
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) walk(path);
			else if (entry.endsWith('.vue')) found.push(path);
		}
	};
	walk(absolute);
	return found;
}

interface Offence {
	readonly file: string;
	readonly line: number;
	readonly text: string;
}

/**
 * Every line that starts a looping animation without opting out of it. Checked
 * per LINE because that is the unit both spellings share: a static
 * `class="… animate-spin …"` and a conditional
 * `:class="{ 'animate-spin motion-reduce:animate-none': busy }"` (where the
 * variant has to ride along inside the object key, or it is applied whether or
 * not the animation is).
 */
function findOffences(): Offence[] {
	const offences: Offence[] = [];
	for (const root of ROOTS) {
		for (const file of vueFilesUnder(root)) {
			const lines = readFileSync(file, 'utf8').split('\n');
			for (const [index, text] of lines.entries()) {
				if (!LOOPING_ANIMATION.test(text)) continue;
				if (text.includes(OPT_OUT)) continue;
				offences.push({
					file: relative(repoRoot, file),
					line: index + 1,
					text: text.trim(),
				});
			}
		}
	}
	return offences;
}

describe('looping animations honour prefers-reduced-motion', () => {
	it('every animate-spin / animate-pulse carries motion-reduce:animate-none', () => {
		const offences = findOffences();
		// Printed as a list of `file:line — the offending markup` so the fix is a
		// paste, not an investigation.
		expect(offences.map((o) => `${o.file}:${o.line} — ${o.text}`)).toEqual([]);
	});

	it('is actually reading the source it claims to cover', () => {
		// A grep that matches nothing looks exactly like a codebase with nothing
		// to fix. Every root has to exist and hold .vue files, and the tokens the
		// rule is about have to still be findable.
		for (const root of ROOTS) {
			expect(vueFilesUnder(root).length, `${root} has no .vue files`).toBeGreaterThan(0);
		}
		const guarded = ROOTS.flatMap(vueFilesUnder).filter((file) =>
			readFileSync(file, 'utf8').includes(OPT_OUT)
		);
		// The sweep that introduced this rule touched ~135 files; a scan that
		// finds a handful is reading the wrong tree.
		expect(guarded.length).toBeGreaterThan(100);
	});
});

describe('page transitions honour prefers-reduced-motion', () => {
	// The route transition is pure CSS (a named Vue transition), so the only
	// place its off switch can live is the stylesheet's reduced-motion block.
	const css = readFileSync(join(repoRoot, 'apps/web/app/assets/css/page-transitions.css'), 'utf8');

	it('turns the page and layout transitions into an instant, static swap', () => {
		const start = css.indexOf('@media (prefers-reduced-motion: reduce)');
		expect(start).toBeGreaterThan(-1);
		const reduced = css.slice(start);
		expect(reduced).toContain('transition: none;');
		expect(reduced).toContain('transform: none;');
	});
});

/**
 * The app's own "Reduce motion" setting (Preferences → Reading comfort) has to
 * reach everything the OS preference reaches. JavaScript gets it through the
 * shared owner in packages/ui (prefersReducedMotion / useReducedMotion), never
 * a raw media-query read; CSS gets it through `:root[data-motion='reduce']`.
 */
describe('the in-app Reduce motion switch reaches what the OS preference does', () => {
	const SOURCE_ROOTS = ['apps/web/app', 'packages/ui', 'packages/email-builder/src'];
	const OWNER = 'packages/ui/composables/useReducedMotion.ts';

	function filesUnder(root: string, extensions: readonly string[]): string[] {
		const found: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir)) {
				if (SKIP_DIRS.has(entry)) continue;
				const path = join(dir, entry);
				if (statSync(path).isDirectory()) walk(path);
				else if (extensions.some((ext) => entry.endsWith(ext))) found.push(path);
			}
		};
		walk(join(repoRoot, root));
		return found;
	}

	it('reads reduced motion in JavaScript only through the shared owner', () => {
		const direct = /matchMedia(?:\?\.)?\(\s*['"`]\(prefers-reduced-motion/;
		const offences: string[] = [];
		for (const root of SOURCE_ROOTS) {
			for (const file of filesUnder(root, ['.ts', '.vue'])) {
				const rel = relative(repoRoot, file);
				if (rel === OWNER) continue;
				const lines = readFileSync(file, 'utf8').split('\n');
				for (const [index, text] of lines.entries()) {
					if (direct.test(text)) offences.push(`${rel}:${index + 1} — ${text.trim()}`);
				}
			}
		}
		expect(offences).toEqual([]);
	});

	it('never scrolls smoothly without asking the shared owner first', () => {
		// The CSS floor turns off `scroll-behavior: smooth`, but an explicit
		// `behavior: 'smooth'` passed to scrollTo / scrollIntoView overrides any
		// stylesheet, so every caller has to pick 'auto' itself when motion is
		// reduced (`prefersReducedMotion() ? 'auto' : 'smooth'`).
		const unconditional = /behavior:\s*['"`]smooth['"`]/;
		const offences: string[] = [];
		for (const root of SOURCE_ROOTS) {
			for (const file of filesUnder(root, ['.ts', '.vue'])) {
				const rel = relative(repoRoot, file);
				// The owner's own doc comment spells the pattern out.
				if (rel === OWNER) continue;
				const lines = readFileSync(file, 'utf8').split('\n');
				for (const [index, text] of lines.entries()) {
					if (unconditional.test(text)) offences.push(`${rel}:${index + 1} — ${text.trim()}`);
				}
			}
		}
		expect(offences).toEqual([]);
	});

	it('gives every OS-only rule that does more than stop motion a data-motion twin', () => {
		const missing: string[] = [];
		let checked = 0;
		for (const root of SOURCE_ROOTS) {
			for (const file of filesUnder(root, ['.css', '.vue'])) {
				const css = readFileSync(file, 'utf8');
				checked += cssRules(css).filter((rule) => rule.osReduced).length;
				for (const gap of missingMotionTwins(css))
					missing.push(`${relative(repoRoot, file)} — ${gap}`);
			}
		}
		expect(missing).toEqual([]);
		// A scan that finds no rules is reading the wrong tree.
		expect(checked).toBeGreaterThan(10);
	});

	it('fails when one twin goes missing while the file keeps others', () => {
		const css = readFileSync(join(repoRoot, 'packages/ui/assets/css/motion.css'), 'utf8');
		const twin = ":root[data-motion='reduce'] .ui-press:active {\n\tscale: none;\n}\n";
		expect(css).toContain(twin);
		expect(missingMotionTwins(css)).toEqual([]);
		expect(missingMotionTwins(css.replace(twin, ''))).toEqual([
			'.ui-press:active { scale: none; }',
		]);
		// A twin with a different declaration is no twin either.
		expect(missingMotionTwins(css.replace(twin, twin.replace('scale: none', 'scale: 1')))).toEqual([
			'.ui-press:active { scale: none; }',
		]);
	});
});

const OS_REDUCED = '@media (prefers-reduced-motion: reduce)';
const APP_REDUCED = ":root[data-motion='reduce'] ";

interface CssRule {
	readonly selectors: readonly string[];
	readonly declarations: readonly string[];
	/** Inside an `@media (prefers-reduced-motion: reduce)` block. */
	readonly osReduced: boolean;
}

/** Split on commas outside parentheses (`:where(a, b)` stays one selector). */
function splitTopLevel(text: string, separator: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let from = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '(') depth++;
		else if (text[i] === ')') depth--;
		else if (text[i] === separator && depth === 0) {
			parts.push(text.slice(from, i));
			from = i + 1;
		}
	}
	parts.push(text.slice(from));
	return parts.map((part) => part.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

function normaliseDeclaration(declaration: string): string {
	const colon = declaration.indexOf(':');
	return `${declaration.slice(0, colon).trim()}: ${declaration
		.slice(colon + 1)
		.trim()
		.replace(/\s+/g, ' ')}`;
}

/**
 * Every style rule in a stylesheet (or a .vue file's style blocks), flattened
 * out of @layer / @media / @supports, keyframes skipped. Enough of a CSS
 * parser for this repo's hand-written sheets, which use no nesting.
 */
function cssRules(source: string): CssRule[] {
	const rules: CssRule[] = [];
	const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
	const walk = (text: string, osReduced: boolean): void => {
		let from = 0;
		for (let i = 0; i < text.length; i++) {
			if (text[i] === ';' && text.slice(from, i).trim().startsWith('@')) {
				from = i + 1;
				continue;
			}
			if (text[i] !== '{') continue;
			let depth = 0;
			let end = i;
			for (; end < text.length; end++) {
				if (text[end] === '{') depth++;
				else if (text[end] === '}' && --depth === 0) break;
			}
			const prelude = text.slice(from, i).trim().replace(/\s+/g, ' ');
			const body = text.slice(i + 1, end);
			if (prelude.startsWith('@')) {
				if (!/^@(?:-webkit-)?keyframes/.test(prelude)) {
					walk(body, osReduced || prelude.startsWith(OS_REDUCED));
				}
			} else {
				rules.push({
					// A .vue file's `<style scoped>` tag ends up in the first prelude.
					selectors: splitTopLevel(prelude.replace(/^[\s\S]*<style[^>]*>/, ''), ','),
					declarations: splitTopLevel(body, ';')
						.filter((d) => d.includes(':'))
						.map(normaliseDeclaration),
					osReduced,
				});
			}
			i = end;
			from = end + 1;
		}
	};
	walk(css, false);
	return rules;
}

/**
 * The OS-only reduced-motion rules of one stylesheet that have no matching
 * `:root[data-motion='reduce']` twin, as `selector { declaration; }` per gap.
 * A rule made only of `transition: none` / `animation: none` is the global
 * floor's job (base.css collapses durations for both switches); every other
 * rule (dropping a transform, parking a sweep, hiding a ring) is a static end
 * state the floor cannot produce, so each of its selectors needs every one of
 * its declarations again under the root attribute.
 */
function missingMotionTwins(css: string): string[] {
	const floorOnly = /^(?:transition|animation): none$/;
	const rules = cssRules(css);
	const twins = new Map<string, Set<string>>();
	for (const rule of rules) {
		if (rule.osReduced) continue;
		for (const selector of rule.selectors) {
			const quoted = selector.replace(/"/g, "'");
			if (!quoted.startsWith(APP_REDUCED)) continue;
			const target = quoted.slice(APP_REDUCED.length);
			const known = twins.get(target) ?? new Set<string>();
			for (const declaration of rule.declarations) known.add(declaration);
			twins.set(target, known);
		}
	}
	const missing: string[] = [];
	for (const rule of rules) {
		if (!rule.osReduced || rule.declarations.every((d) => floorOnly.test(d))) continue;
		for (const selector of rule.selectors) {
			for (const declaration of rule.declarations) {
				if (!twins.get(selector)?.has(declaration)) {
					missing.push(`${selector} { ${declaration}; }`);
				}
			}
		}
	}
	return missing;
}
