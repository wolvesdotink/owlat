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
			lines.forEach((text, index) => {
				if (!LOOPING_ANIMATION.test(text)) return;
				if (text.includes(OPT_OUT)) return;
				offences.push({
					file: relative(repoRoot, file),
					line: index + 1,
					text: text.trim(),
				});
			});
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
