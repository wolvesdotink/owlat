/**
 * The slash menu groups commands by category, so its order differs from the
 * registry's. The editor confirms the highlighted index against the menu's
 * order (orderSlashCommands), so Enter inserts the row that is highlighted.
 */
import { describe, expect, it } from 'vitest';
import type { SlashCommand } from '../../../types';
import { orderSlashCommands } from '../SlashCommandMenu.vue';

function command(id: string, category: SlashCommand['category']): SlashCommand {
	return { id, category } as SlashCommand;
}

describe('orderSlashCommands', () => {
	it('puts layout before components, keeping registry order inside a category', () => {
		const registryOrder = [
			command('heading', 'text'),
			command('button', 'components'),
			command('divider', 'layout'),
			command('image', 'media'),
			command('spacer', 'layout'),
		];

		expect(orderSlashCommands(registryOrder).map((c) => c.id)).toEqual([
			'heading',
			'image',
			'divider',
			'spacer',
			'button',
		]);
	});

	it('places commands of an unknown category last', () => {
		const ordered = orderSlashCommands([
			command('plugin', 'other' as SlashCommand['category']),
			command('heading', 'text'),
		]);
		expect(ordered.map((c) => c.id)).toEqual(['heading', 'plugin']);
	});
});
