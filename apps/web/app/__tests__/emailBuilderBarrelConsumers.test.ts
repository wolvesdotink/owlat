// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * WHO MAY LOAD THE EMAIL BUILDER (#1441).
 *
 * The `@owlat/email-builder` barrel evaluates the whole editor: its components,
 * the block registries and the renderer. A page that imports one value from it,
 * even just the unsaved-changes dialog, ships all of that (about 208 KB gzip).
 * These pages and helpers never edit email: they take the dialog from the
 * `@owlat/ui` layer (auto-registered as `UiUnsavedChangesDialog`) and the
 * stored-block reader from the `@owlat/email-builder/stored-blocks` leaf.
 * Type-only imports are erased at build time and stay allowed.
 */

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '..');
const builderPackage = resolve(here, '..', '..', '..', '..', 'packages', 'email-builder');

const NON_EDITOR_CONSUMERS = [
	'pages/dashboard/preferences/account.vue',
	'pages/dashboard/admin/instance/general.vue',
	'pages/dashboard/admin/instance/ai-provider.vue',
	'pages/dashboard/admin/instance/ai-replies.vue',
	'pages/dashboard/admin/instance/brand-kit.vue',
	'pages/dashboard/admin/instance/desktop-updates.vue',
	'pages/dashboard/admin/instance/forms.vue',
	'pages/dashboard/admin/delivery/provider-routing.vue',
	'pages/dashboard/admin/delivery/webhooks.vue',
	'pages/dashboard/audience/segments/index.vue',
	'pages/dashboard/automations/[id]/edit.vue',
	'pages/dashboard/campaigns/[id]/edit.vue',
	'pages/dashboard/send/emails/[id]/settings.vue',
	'components/translation/Manager.vue',
	'composables/translationSave.ts',
	'composables/emailSettingsRender.ts',
	// The renderer behind the settings page and translation saves.
	'composables/useEmailHtmlRendering.ts',
];

/** The pages that show the leave prompt, among the consumers above. */
const DIALOG_PAGES = NON_EDITOR_CONSUMERS.filter((file) => file.endsWith('.vue'));

/** Every static import statement whose specifier is exactly the builder barrel. */
function barrelImports(source: string): string[] {
	return [...source.matchAll(/^import\s[^;]*?['"]@owlat\/email-builder['"]/gms)].map((m) => m[0]);
}

const read = (file: string): string => readFileSync(resolve(app, file), 'utf8');

describe('non-editor pages stay off the email builder barrel', () => {
	it.each(NON_EDITOR_CONSUMERS)('%s imports no value from the barrel', (file) => {
		const valueImports = barrelImports(read(file)).filter((stmt) => !/^import\s+type\s/.test(stmt));
		expect(valueImports).toEqual([]);
	});

	it.each(DIALOG_PAGES)('%s renders the dialog from the ui layer', (file) => {
		const source = read(file);
		expect(source).toContain('<UiUnsavedChangesDialog');
		expect(source).not.toMatch(/<UnsavedChangesDialog\b/);
	});

	it('reads the barrel matcher correctly', () => {
		const source = [
			"import type { EditorBlock } from '@owlat/email-builder';",
			"import { parseStoredBlocks } from '@owlat/email-builder/stored-blocks';",
			"import {\n\tEmailBuilder,\n\tuseFocusMode,\n} from '@owlat/email-builder';",
		].join('\n');
		expect(barrelImports(source)).toEqual([
			"import type { EditorBlock } from '@owlat/email-builder'",
			"import {\n\tEmailBuilder,\n\tuseFocusMode,\n} from '@owlat/email-builder'",
		]);
	});
});

describe('the stored-blocks subpath is a leaf', () => {
	const manifest = JSON.parse(readFileSync(resolve(builderPackage, 'package.json'), 'utf8')) as {
		exports: Record<string, { import: string }>;
	};

	it('points at the stored-block reader', () => {
		expect(manifest.exports['./stored-blocks']?.import).toBe('./src/utils/storedBlocks.ts');
	});

	it('reaches no editor module through its value imports', () => {
		// Walk the package-relative value imports and re-exports from the subpath entry: the
		// reader reaches no other builder module (its id repair comes from
		// @owlat/shared/blockTree), so never a component, a registry or the barrel.
		const seen = new Set<string>();
		const pending = [resolve(builderPackage, manifest.exports['./stored-blocks']!.import)];
		while (pending.length > 0) {
			const file = pending.pop()!;
			if (seen.has(file)) continue;
			seen.add(file);
			const source = readFileSync(file, 'utf8');
			for (const [stmt, spec] of source.matchAll(
				/^(?:import|export)\s[^;]*?['"](\.[^'"]+)['"]/gms
			)) {
				if (/^(?:import|export)\s+type\s/.test(stmt)) continue;
				pending.push(resolve(dirname(file), spec!.endsWith('.ts') ? spec! : `${spec}.ts`));
			}
		}
		const reached = [...seen].map((file) => file.slice(builderPackage.length + 1)).sort();
		expect(reached).toEqual(['src/utils/storedBlocks.ts']);
	});
});
