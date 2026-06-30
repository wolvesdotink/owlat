import { Minus } from '@lucide/vue';
import { moduleFor } from '@owlat/email-renderer';
import type { EditorModule } from '../_module';
import type { DividerBlockContent } from '../../types';
import { dividerSchema } from '../../schema/definitions/divider';

export const dividerEditor: EditorModule<'divider'> = {
	type: 'divider',
	label: 'Divider',
	icon: Minus,
	schema: dividerSchema,
	slashCommand: {
		name: 'Divider',
		description: 'Visual separator line',
		category: 'layout',
		aliases: ['hr', 'line', 'separator'],
	},
	canBeInColumn: true,
	canBeInContainer: true,
	createDefaultColumnItem: (theme) =>
		moduleFor('divider')!.createDefault!(theme) as DividerBlockContent,
};
