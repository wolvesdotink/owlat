/**
 * The seam between the `ostr` feature flag and the pixel.
 *
 * `PostboxAuthBadge` is unit-tested with props handed to it directly, and
 * `deriveOstrChip` is unit-tested on its own — but the one thing neither covers
 * is the single line of the reader that connects them, and that line fails
 * SILENTLY in three different ways:
 *
 *   - a typo'd attribute (`:ostr-enabld`) is a fallthrough attribute to Vue, and
 *     vue-tsc does not reject it;
 *   - a dropped `:ostr-tier` / `:ostr-enabled` just leaves an optional prop
 *     undefined, so the chip quietly never renders;
 *   - `isFeatureEnabled('ostr')` turning into a different key — or picking up a
 *     `!` — flips the whole feature with nothing red.
 *
 * Mounting `PostboxThreadReader` would mean stubbing the entire Convex + Nuxt
 * surface it queries, so this reads the SHIPPED source and asserts against its
 * real compiled template AST (not a regex over markup, so an attribute rename is
 * a changed prop NAME rather than a passing substring match) — the same
 * "assert against the source of truth" approach `app/__tests__/keyboardOperableRows.test.ts`
 * takes for the keyboard-operable rows.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'vue/compiler-sfc';
import type { ElementNode, TemplateChildNode } from '@vue/compiler-core';

/**
 * Read through a variable, like `keyboardOperableRows` does: a literal
 * `new URL('./x.vue', import.meta.url)` is rewritten by Vite into an asset URL
 * before it ever reaches `fileURLToPath`.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const { descriptor, errors } = parse(read('../PostboxThreadReader.vue'));

/** Every `<PostboxAuthBadge>` in the template, wherever it is nested. */
function findBadges(node: TemplateChildNode | ElementNode, found: ElementNode[] = []) {
	if ('tag' in node && node.tag === 'PostboxAuthBadge') found.push(node);
	for (const child of ('children' in node ? node.children : []) as TemplateChildNode[]) {
		if (typeof child === 'object') findBadges(child, found);
	}
	// `v-if` chains hang their arms off `branches` rather than `children`.
	if ('branches' in node) {
		for (const branch of node.branches) findBadges(branch as unknown as ElementNode, found);
	}
	return found;
}

/** The expression bound to `name` — `null` when the prop is not bound at all. */
function boundExpression(badge: ElementNode, name: string): string | null {
	for (const prop of badge.props) {
		if (prop.type !== 7 || prop.name !== 'bind') continue;
		if (prop.arg?.type === 4 && prop.arg.content === name) {
			return prop.exp?.type === 4 ? prop.exp.content : null;
		}
	}
	return null;
}

describe('PostboxThreadReader — OSTR chip wiring', () => {
	it('parses, and mounts exactly one sender-auth badge', () => {
		expect(errors).toEqual([]);
		expect(findBadges(descriptor.template!.ast!)).toHaveLength(1);
	});

	it('passes the flag gate and the persisted tier to the badge, by their real prop names', () => {
		const badge = findBadges(descriptor.template!.ast!)[0]!;
		// A misspelled attribute becomes a fallthrough attr with no complaint from
		// vue-tsc, so the prop NAMES are what this pins.
		expect(boundExpression(badge, 'ostr-enabled')).toBe('ostrEnabled');
		// The tier as persisted at delivery — never re-derived client-side.
		expect(boundExpression(badge, 'ostr-tier')).toBe('msg.ostrTier');
		// The chip lives inside the auth badge, so the badge's own gate has to be
		// wired too or there is nothing for the chip to live in.
		expect(boundExpression(badge, 'enabled')).toBe('authBadgesEnabled');
	});

	it('gates the chip on the `ostr` flag, un-negated', () => {
		// Not a substring check: the whole assignment, so a stray `!` or a renamed
		// flag key fails rather than still matching somewhere in the file.
		expect(descriptor.scriptSetup?.content).toContain(
			"const ostrEnabled = computed(() => isFeatureEnabled('ostr'));"
		);
	});
});
