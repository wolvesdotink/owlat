import { afterEach, describe, expect, it } from 'vitest';
import { getAllEditorModules } from '../../blocks';
import { EDITOR_SHORTCUTS, EDITOR_SHORTCUT_GROUPS } from '../../composables/editorShortcuts';
import { useSlashCommands } from '../../composables/useSlashCommands';
import { devicePresets, emailClients } from '../../preview/data/clients';
import type { PropertyField } from '../../schema/types';
import { conditionOperatorOptions } from '../../utils/blockCondition';
import { translateLabel } from '../useBuilderI18n';

/**
 * Registry copy — block names, slash-menu entries, every property-panel label,
 * option, placeholder and help text, shortcut descriptions, device names — is
 * declared in English on frozen registry entries and translated where it is
 * shown (`label()`). Nothing ties a new schema field to the catalog, so this
 * walks the real registries and requires a German translation for every string,
 * except the ones that are the same in German by design.
 */

/** Proper nouns, symbols, technical examples and words German shares. */
const SAME_IN_GERMAN = new Set([
	// Words German uses unchanged.
	'Text',
	'Normal',
	'Layout',
	'Button',
	'Links',
	'Container',
	'Hero',
	'Position',
	'Horizontal',
	'Icon',
	'Video',
	'HTML',
	'URL',
	'LTR',
	'RTL',
	'Srcset',
	'Logo',
	// Product names.
	'Twitter / X',
	'Facebook',
	'Instagram',
	'LinkedIn',
	'YouTube',
	'TikTok',
	'GitHub',
	'WhatsApp',
	'Telegram',
	'Threads',
	'Pinterest',
	'Discord',
	'Mastodon',
	'Bluesky',
	'Vimeo',
	'Medium',
	'Snapchat',
	'iPhone Pro Max',
	'iPhone Pro',
	'iPhone SE',
	'Desktop (1440px)',
	'Desktop (1200px)',
	'Desktop (1024px)',
	// Technical values and examples typed over, not read.
	'auto',
	'https://',
	'https://youtube.com/watch?v=...',
	'image@2x.png 2x',
	'(max-width: 600px) 100vw',
	'|',
	'1',
	'2',
	'3',
	'4',
	// Key chips that read the same on a German keyboard.
	'Mod',
	'Alt',
	'Esc',
	'Z',
	'F',
	'D',
	'B',
	'I',
	'U',
	'K',
	'?',
	'/',
	'↑',
	'↓',
]);

function fieldCopy(field: PropertyField): string[] {
	return [
		field.label,
		...(field.placeholder ? [field.placeholder] : []),
		...(field.helpText ? [field.helpText] : []),
		...(field.options ?? []).map((option) => option.label),
		...(field.itemSchema ?? []).flatMap(fieldCopy),
	];
}

function registryCopy(): string[] {
	const slash = useSlashCommands();
	slash.setBrandBlocks(['logo', 'footer']);
	const commands = slash.filteredCommands.value;
	const copy = [
		...getAllEditorModules().flatMap((module) => [
			module.label,
			...(module.slashCommand ? [module.slashCommand.name, module.slashCommand.description] : []),
			...(module.schema
				? [
						module.schema.label,
						...module.schema.groups.flatMap((group) => [
							group.label,
							...group.fields.flatMap(fieldCopy),
						]),
					]
				: []),
		]),
		...commands.flatMap((command) => [command.name, command.description]),
		...EDITOR_SHORTCUTS.flatMap((shortcut) => [shortcut.description, ...shortcut.keys]),
		...EDITOR_SHORTCUT_GROUPS,
		'Ctrl',
		...conditionOperatorOptions.map((option) => option.label),
		...devicePresets.map((device) => device.name),
		...emailClients.flatMap((client) => client.quirks ?? []),
		// The sidebar's brand buttons and the border editor's styles, the saved-block fallback.
		'Brand logo',
		'Brand footer',
		'None',
		'Solid',
		'Dashed',
		'Dotted',
		'Saved block',
	];
	return [...new Set(copy)];
}

afterEach(() => {
	useSlashCommands().setBrandBlocks([]);
});

describe('registry copy', () => {
	it('walks the whole registry', () => {
		// 17 block types with their schemas, plus shortcuts, devices and slash entries.
		expect(registryCopy().length).toBeGreaterThan(300);
	});

	it('has a German translation for every string', () => {
		const untranslated = registryCopy().filter(
			(source) => !SAME_IN_GERMAN.has(source) && translateLabel('de', source) === source
		);
		expect(untranslated).toEqual([]);
	});

	it('lists only strings the registry still has as same-in-German', () => {
		const copy = new Set(registryCopy());
		expect([...SAME_IN_GERMAN].filter((source) => !copy.has(source))).toEqual([]);
	});
});
