/**
 * Both icon scans that feed the client bundle skip test files.
 *
 * Every name a scan finds is bundled into the entry chunk that every page loads,
 * so a name only a test quotes costs every visitor bytes and renders nothing.
 * The app scan is @nuxt/icon's (nuxt.config.ts `icon.clientBundle.scan`, globbed
 * against apps/web); the packages/ui layer is read by `uiLayerIconNames()`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, matchesGlob } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ICON_SCAN_EXCLUDE, uiLayerIconNames } from '../../scripts/uiLayerIcons';

const sandboxes: string[] = [];

afterEach(() => {
	while (sandboxes.length > 0) {
		const dir = sandboxes.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'owlat-ui-icons-'));
	sandboxes.push(root);
	for (const [path, source] of Object.entries(files)) {
		mkdirSync(join(root, dirname(path)), { recursive: true });
		writeFileSync(join(root, path), source);
	}
	return root;
}

describe('uiLayerIconNames', () => {
	it('reads components and modules but not tests', () => {
		const root = tree({
			'components/Thing.vue': '<Icon name="lucide:check" />',
			'composables/useThing.ts': "export const icon = 'lucide:x';",
			'components/__tests__/Thing.test.ts': "expect(html).toContain('lucide:skull');",
			'components/__tests__/fixtures.ts': "export const icon = 'lucide:kanban';",
			'composables/useThing.test.ts': "expect(icon).toBe('lucide:box');",
			'composables/useThing.spec.ts': "expect(icon).toBe('lucide:dot');",
		});

		expect(uiLayerIconNames(root)).toEqual(['lucide:check', 'lucide:x']);
	});
});

describe('the app icon scan exclusions', () => {
	const excluded = (path: string) =>
		ICON_SCAN_EXCLUDE.some((pattern) => matchesGlob(path, pattern));

	it('skips test directories and test files', () => {
		expect(excluded('app/components/__tests__/Thing.test.ts')).toBe(true);
		expect(excluded('app/components/__tests__/fixtures.ts')).toBe(true);
		expect(excluded('app/utils/thing.test.ts')).toBe(true);
		expect(excluded('app/utils/thing.spec.ts')).toBe(true);
	});

	it('keeps the shipped sources', () => {
		expect(excluded('app/components/Thing.vue')).toBe(false);
		expect(excluded('app/utils/testing.ts')).toBe(false);
		expect(excluded('app/utils/contestEntries.ts')).toBe(false);
		expect(excluded('i18n/locales/en.yml')).toBe(false);
	});

	it("keeps @nuxt/icon's own defaults, which setting the option replaces", () => {
		expect(ICON_SCAN_EXCLUDE).toEqual(
			expect.arrayContaining(['node_modules', 'dist', 'build', 'coverage', 'test', 'tests', '.*'])
		);
	});
});
