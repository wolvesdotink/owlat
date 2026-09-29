// @vitest-environment node
/**
 * The reader's thread-swap motion (plan 1.16, F17).
 *
 * The three-pane reader and the Today overlay used an out-in `pbx-reader`
 * <Transition>: a 120ms leave, then a 160ms fade+rise enter. Every j/k and
 * every triage auto-advance waited for both before the next thread painted.
 * The swap is now enter-only: the keyed reader mounts in the same frame the old
 * one goes, and fades in on the fast tier (80ms), opacity only.
 *
 * Reading the source rather than mounting for the CSS half: the timing lives in
 * the stylesheet, which happy-dom does not animate. The overlay suite mounts the
 * swap itself and checks the next thread lands in the same tick.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const motion = read('../../../assets/css/postbox-motion.css');
const tokens = read('../../../../../../packages/ui/assets/css/tokens.css');
const hosts = {
	layout: read('../PostboxLayout.vue'),
	overlay: read('../PostboxTodayReaderOverlay.vue'),
	today: read('../PostboxTodayView.vue'),
};

/** The body of the first rule/at-rule whose prelude matches exactly. */
function block(source: string, prelude: string): string {
	const escaped = prelude.replace(/[.[\]()*+?^$|\\{}-]/g, '\\$&');
	const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source);
	expect(match, `rule for \`${prelude}\``).not.toBeNull();
	return match![1]!;
}

/** Resolve a `var(--x)` chain through postbox-motion.css and the shared tokens to ms. */
function resolveMs(value: string): number {
	const direct = /^(\d+)ms$/.exec(value.trim());
	if (direct) return Number(direct[1]);
	const ref = /^var\((--[\w-]+)\)$/.exec(value.trim());
	expect(ref, `a duration or var(), got \`${value}\``).not.toBeNull();
	const decl = new RegExp(`${ref![1]}:\\s*([^;]+);`).exec(motion + tokens);
	expect(decl, `declaration of ${ref![1]}`).not.toBeNull();
	return resolveMs(decl![1]!);
}

describe('reader swap motion', () => {
	it('has no leave rule and no out-in transition left', () => {
		expect(motion).not.toMatch(/\.pbx-reader-(enter|leave)/);
		for (const [name, source] of Object.entries(hosts)) {
			expect(source, name).not.toContain('name="pbx-reader"');
		}
	});

	it('fades in on an 80-100ms opacity-only enter', () => {
		const rule = block(motion, '.pbx-reader-swap');
		const animation = /animation:\s*([\w-]+)\s+(var\([^)]+\)|\d+ms)/.exec(rule);
		expect(animation).not.toBeNull();
		const ms = resolveMs(animation![2]!);
		expect(ms).toBeGreaterThanOrEqual(80);
		expect(ms).toBeLessThanOrEqual(100);

		// Opacity only, so it already is what prefers-reduced-motion asks for.
		const keyframes = block(motion, `@keyframes ${animation![1]}`);
		expect(keyframes).toContain('opacity: 0');
		expect(keyframes).not.toMatch(/transform|translate|scale/);
	});

	it('is applied to the keyed reader in both hosts and to the Today overlay', () => {
		expect(hosts.layout).toMatch(/<PostboxThreadReader[^>]*class="pbx-reader-swap"/);
		expect(hosts.overlay).toMatch(/<PostboxThreadReader[^>]*class="pbx-reader-swap"/);
		expect(hosts.today).toMatch(/<PostboxTodayReaderOverlay[^>]*class="pbx-reader-swap"/);
	});
});
