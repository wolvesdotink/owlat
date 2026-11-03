import { MenuIcon } from '@coolicons/vue';
import type { EditorModule } from '../_module';
import { menuSchema } from '../../schema/definitions/menu';

export const menuEditor: EditorModule<'menu'> = {
	type: 'menu',
	label: 'Menu',
	icon: MenuIcon,
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
