/**
 * TRANSITIONS NAME THEIR PROPERTIES, AND PROGRESS FILLS DO NOT ANIMATE WIDTH.
 *
 * `transition-all` (and `transition: all`) animates whatever happens to change,
 * including layout properties nobody meant to animate: a padding tweak on hover
 * or a font-weight swap becomes a multi-frame relayout. Naming the properties
 * keeps a transition on the compositor-friendly ones the design asked for.
 *
 * A progress or meter fill that animates `width` re-lays-out its row on every
 * frame of the transition. Fills slide a full-width layer with `transform`
 * instead: `.ui-meter-fill` + `meterFillStyle()` (packages/ui).
 *
 * A SOURCE lint, like reducedMotion.lint.test.ts: the property is about the
 * class strings and declarations themselves. It cannot see a class assembled at
 * runtime out of fragments, so the counter-check at the bottom fails if the
 * scan stops finding anything.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** Every product surface that ships Vue: the app, the shared layer, the builder, the docs site. */
const ROOTS = [
	'apps/web/app',
	'packages/ui/components',
	'packages/ui/assets/css',
	'packages/email-builder/src',
	'apps/docs/app',
];

const SKIP_DIRS = new Set(['node_modules', '__tests__', 'dist', '.nuxt', '.output']);

/** `transition-all`, `transition: all …` and `transition-property: all`. */
const TRANSITION_ALL = /\btransition-all\b|\btransition(?:-property)?:\s*all\b/;

/**
 * A width transition: the Tailwind utilities, or a CSS / inline-style
 * declaration that lists `width` (not `stroke-width`, `max-width`, …).
 */
const WIDTH_TRANSITION =
	/\btransition-\[(?:[^\]]*,)?width\b|\btransition-width\b|\btransition(?:-property)?:\s*['"]?(?:[^;'"]*,\s*)?width\b/;

/**
 * The width transitions that are not progress fills, each with the reason it
 * keeps animating layout. Keyed by repo-relative path.
 */
const WIDTH_ALLOWED: Record<string, string> = {
	// The queue position dots: a finished/current dot grows from a 6px dot to a
	// 20px bar once per step, and its neighbours have to move with it.
	'apps/web/app/components/agent-tasks/AgentTaskFlow.vue': 'step dots grow in the flow',
	// The selection pill slides to the measured left/width of the chosen
	// segment; it is absolutely positioned, so only the pill itself re-lays out.
	'packages/ui/components/ui/SegmentedControl.vue': 'selection indicator',
	// The device preview morphs between desktop, tablet and phone sizes.
	'packages/email-builder/src/preview/components/DeviceFrame.vue': 'device frame resize',
	// The canvas mirror of the email progress-bar block: the sent email draws
	// its fill as a table-cell width, and the canvas keeps the same geometry.
	'packages/email-builder/src/components/canvas/previews/ProgressBarPreview.vue':
		'mirrors the email markup',
};

function sourceFilesUnder(root: string): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			if (SKIP_DIRS.has(entry)) continue;
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) walk(path);
			else if (entry.endsWith('.vue') || entry.endsWith('.css')) found.push(path);
		}
	};
	walk(join(repoRoot, root));
	return found;
}

interface Hit {
	readonly file: string;
	readonly line: number;
	readonly text: string;
}

/**
 * Matched against the whole file, not line by line: the formatter wraps a long
 * `transition-property:` list onto the next line, and a per-line scan would
 * lose the property names it moved.
 */
function scan(pattern: RegExp): Hit[] {
	const global = new RegExp(pattern.source, 'g');
	const hits: Hit[] = [];
	for (const root of ROOTS) {
		for (const path of sourceFilesUnder(root)) {
			const file = relative(repoRoot, path);
			const source = readFileSync(path, 'utf8');
			const lines = source.split('\n');
			for (const match of source.matchAll(global)) {
				const line = source.slice(0, match.index).split('\n').length;
				hits.push({ file, line, text: lines[line - 1]!.trim() });
			}
		}
	}
	return hits;
}

const format = (hits: Hit[]) => hits.map((h) => `${h.file}:${h.line} — ${h.text}`);

describe('transitions name the properties they animate', () => {
	it('no transition-all / transition: all', () => {
		expect(format(scan(TRANSITION_ALL))).toEqual([]);
	});

	it('no width transitions outside the listed non-fill exceptions', () => {
		const offences = scan(WIDTH_TRANSITION).filter((hit) => !(hit.file in WIDTH_ALLOWED));
		expect(format(offences)).toEqual([]);
	});

	it('keeps every width exception live, so a fixed file drops off the list', () => {
		const hitFiles = new Set(scan(WIDTH_TRANSITION).map((hit) => hit.file));
		expect(Object.keys(WIDTH_ALLOWED).filter((file) => !hitFiles.has(file))).toEqual([]);
	});

	it('is actually reading the source it claims to cover', () => {
		for (const root of ROOTS) {
			expect(sourceFilesUnder(root).length, `${root} has no source files`).toBeGreaterThan(0);
		}
		// The patterns still match the spellings they police.
		expect(TRANSITION_ALL.test('class="transition-all duration-300"')).toBe(true);
		expect(TRANSITION_ALL.test('transition: all var(--motion-fast);')).toBe(true);
		expect(TRANSITION_ALL.test('transition: opacity var(--motion-fast);')).toBe(false);
		expect(WIDTH_TRANSITION.test('class="transition-[width] duration-300"')).toBe(true);
		expect(WIDTH_TRANSITION.test('class="transition-[opacity,width]"')).toBe(true);
		expect(WIDTH_TRANSITION.test('class="transition-[opacity,max-width]"')).toBe(false);
		expect(WIDTH_TRANSITION.test('transition: width 160ms ease;')).toBe(true);
		expect(WIDTH_TRANSITION.test("transition: 'width var(--motion-moderate) ease',")).toBe(true);
		expect(WIDTH_TRANSITION.test('transition-property: opacity, width;')).toBe(true);
		expect(WIDTH_TRANSITION.test('transition-property:\n\t\twidth, height;')).toBe(true);
		expect(WIDTH_TRANSITION.test('transition: stroke-width 160ms;')).toBe(false);
		expect(WIDTH_TRANSITION.test('transition: max-width 160ms;')).toBe(false);
		// And the fills this rule protects are still drawn the layout-free way.
		const fills = scan(/\bui-meter-fill\b/);
		expect(fills.length).toBeGreaterThan(15);
	});
});
