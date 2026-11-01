import { MoveVerticalIcon } from '@coolicons/vue';
import type { EditorModule } from '../_module';
import type { SpacerBlockContent } from '../../types';
import { spacerSchema } from '../../schema/definitions/spacer';

export const spacerEditor: EditorModule<'spacer'> = {
	type: 'spacer',
	label: 'Spacer',
	icon: MoveVerticalIcon,
	schema: spacerSchema,
	slashCommand: {
		name: 'Spacer',
		description: 'Vertical spacing',
		category: 'layout',
		aliases: ['space', 'gap'],
	},
	canBeInColumn: true,
	canBeInContainer: true,
	createDefaultColumnItem: () => ({ height: 16 }) as SpacerBlockContent,
};
