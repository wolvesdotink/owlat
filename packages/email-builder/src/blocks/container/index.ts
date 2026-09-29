import { Square } from '@lucide/vue';
import { moduleFor } from '@owlat/email-renderer';
import type { EditorModule } from '../_module';
import type { ContainerBlockContent } from '../../types';
import { containerSchema } from '../../schema/definitions/container';
import { itemsChildrenView, containerChildTypes } from '../_itemsChildren';

export const containerEditor: EditorModule<'container'> = {
	type: 'container',
	label: 'Container',
	icon: Square,
	schema: containerSchema,
	slashCommand: {
		name: 'Container',
		description: 'Group blocks with shared styling',
		category: 'layout',
		aliases: ['box', 'section', 'wrapper', 'group'],
	},
	canBeInColumn: false,
	canBeInContainer: true,

	// Container opts out of the universal defaultPadding/defaultMargin spread —
	// its own getContainerPadding helper owns the inset math.
	createDefault: (theme) => moduleFor('container')!.createDefault!(theme) as ContainerBlockContent,

	childrenView: itemsChildrenView,
	allowedChildTypes: containerChildTypes,
};
