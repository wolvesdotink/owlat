import { List } from '@lucide/vue';
import type { EditorModule } from '../_module';
import { listSchema } from '../../schema/definitions/list';

export const listEditor: EditorModule<'list'> = {
	type: 'list',
	label: 'List',
	icon: List,
	schema: listSchema,
	slashCommand: {
		name: 'List',
		description: 'Bullet or numbered list',
		category: 'components',
		aliases: ['ul', 'ol', 'bullets'],
	},
	canBeInColumn: false,
	canBeInContainer: false,
	supportsBorderRadius: true,
};
