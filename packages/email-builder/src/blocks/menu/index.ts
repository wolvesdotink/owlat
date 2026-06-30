import { Menu } from '@lucide/vue';
import type { EditorModule } from '../_module';
import { menuSchema } from '../../schema/definitions/menu';

export const menuEditor: EditorModule<'menu'> = {
	type: 'menu',
	label: 'Menu',
	icon: Menu,
	schema: menuSchema,
	slashCommand: {
		name: 'Menu',
		description: 'Navigation menu with links',
		category: 'components',
		aliases: ['nav', 'navigation', 'links'],
	},
	canBeInColumn: false,
	canBeInContainer: false,
};
