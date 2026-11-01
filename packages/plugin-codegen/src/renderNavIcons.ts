import type { BundledPlugin } from '@owlat/plugin-host';

const COOLICONS_TOKEN = /^coolicons:([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/** `coolicons:arrow-up-right` → `ArrowUpRightIcon`, the export `@coolicons/vue` names it. */
function componentName(token: string): string {
	const match = COOLICONS_TOKEN.exec(token);
	if (!match) throw new Error(`Invalid bundled plugin icon token: ${JSON.stringify(token)}`);
	const pascal = match[1]!
		.split('-')
		.map((part) => part[0]!.toUpperCase() + part.slice(1))
		.join('');
	return `${pascal}Icon`;
}

/**
 * The icons a bundled plugin's sidebar entries and settings panels name, as
 * static imports and a token → component map for the web composition.
 *
 * The web app renders icons as compiled components, not by name at runtime,
 * so a manifest's `coolicons:<name>` token has to become an import at codegen
 * time. A name coolicons does not export then fails the web typecheck and
 * build instead of rendering an empty box. Only the named icons are imported,
 * so a plugin adds its own glyphs to the bundle and nothing else.
 */
export function renderPluginNavIcons(plugins: readonly BundledPlugin[]): string {
	const tokens = new Set<string>();
	for (const plugin of plugins) {
		const contributes = plugin.manifest.contributes;
		for (const entry of [
			...(contributes?.navItems ?? []),
			...(contributes?.settingsPanels ?? []),
		]) {
			tokens.add(entry.icon);
		}
	}
	const sorted = [...tokens].sort();
	const names = sorted.map(componentName);
	const typeImport = "import type { IconComponent } from '@coolicons/vue';\n";
	const valueImport =
		names.length > 0
			? `import { ${[...new Set(names)].sort().join(', ')} } from '@coolicons/vue';\n`
			: '';
	const entries = sorted
		.map((token, index) => `\t${JSON.stringify(token)}: ${names[index]},`)
		.join('\n');
	const map = entries
		? `export const bundledPluginIcons: Readonly<Record<string, IconComponent>> = Object.freeze({\n${entries}\n});\n`
		: 'export const bundledPluginIcons: Readonly<Record<string, IconComponent>> = Object.freeze({});\n';
	return `${typeImport}${valueImport}\n${map}`;
}
