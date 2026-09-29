import { RectangleHorizontal } from '@lucide/vue';
import type { EditorModule } from '../_module';
import { heroSchema } from '../../schema/definitions/hero';
import { itemsChildrenView, containerChildTypes } from '../_itemsChildren';

export const heroEditor: EditorModule<'hero'> = {
	type: 'hero',
	label: 'Hero',
	icon: RectangleHorizontal,
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
