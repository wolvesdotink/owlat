import { Ratio169Icon } from '@coolicons/vue';
import type { EditorModule } from '../_module';
import { heroSchema } from '../../schema/definitions/hero';
import { itemsChildrenView, containerChildTypes } from '../_itemsChildren';

export const heroEditor: EditorModule<'hero'> = {
	type: 'hero',
	label: 'Hero',
	icon: Ratio169Icon,
	schema: heroSchema,
	slashCommand: {
		name: 'Hero',
		description: 'Hero section with background image',
		category: 'layout',
		aliases: ['banner', 'header', 'jumbotron'],
	},
	canBeInColumn: false,
	canBeInContainer: false,

	childrenView: itemsChildrenView,
	allowedChildTypes: containerChildTypes,
};
