// @vitest-environment node
/**
 * Reply-all and Forward in the reader's per-message action row.
 *
 * They were `hidden group-hover:inline-flex` at every density, so the two verbs
 * people reach for most only existed while a mouse was over the message: not on
 * touch, not while reading, and a second click away in the ⋯ menu. The fix is a
 * density rule, not a component branch — postbox-density.css is the single place
 * every density difference lives (`data-density` on the Postbox root), and a
 * component that re-learned density in TS would be the drift this suite exists
 * to stop.
 *
 * Reading the source rather than mounting: the behaviour IS the CSS cascade,
 * which happy-dom has no layout engine to resolve, and the reader needs a live
 * Convex client to mount at all.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const density = read('../../../assets/css/postbox-density.css');
const reader = read('../PostboxThreadReader.vue');

/** The declaration block of the first rule whose selector matches exactly. */
function block(selector: string): string {
	const match = new RegExp(
		`(?:^|\\n)\\s*${selector.replace(/[.[\]()*+?^$|\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`
	).exec(density);
	expect(match, `rule for \`${selector}\` in postbox-density.css`).not.toBeNull();
	return match![1]!;
}

describe('reader reply-all / forward visibility', () => {
	it('marks both buttons with the density-driven class', () => {
		expect(reader.match(/class="pbx-reader-secondary-action"/g)).toHaveLength(2);
	});

	it('no longer hides them behind a pointer hover at every density', () => {
		expect(reader).not.toContain('group-hover:inline-flex');
	});

	it('shows them by default — which is the comfortable default density', () => {
		expect(block('.pbx-reader-secondary-action')).toContain('display: inline-flex');
	});

	it('trades them for rhythm only in compact', () => {
		expect(block("[data-density='compact'] .pbx-reader-secondary-action")).toContain(
			'display: none'
		);
	});

	it('still reveals them on hover in compact', () => {
		expect(
			block("[data-density='compact'] .pbx-reader-message:hover .pbx-reader-secondary-action")
		).toContain('display: inline-flex');
	});

	it('pins them open where hover never fires, so touch is not left with the ⋯ menu', () => {
		const touch = /@media \(hover: none\) \{([\s\S]*?)\n\}/.exec(density)?.[1] ?? '';
		expect(touch).toContain('.pbx-reader-secondary-action');
	});

	it('hangs the compact hover rule on a class the reader actually renders', () => {
		expect(reader).toContain('pbx-reader-message');
	});
});
