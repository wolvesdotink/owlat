import { Type } from '@lucide/vue';
import type { EditorModule } from '../_module';
import type { TextBlockContent } from '../../types';
import { textSchema } from '../../schema/definitions/text';
import { defaultPadding } from '../../defaults';

export const textEditor: EditorModule<'text'> = {
	type: 'text',
	label: 'Text',
	icon: Type,
	schema: textSchema,
	slashCommand: {
		name: 'Text',
		description: 'Add a paragraph of text',
		category: 'text',
		aliases: ['paragraph', 'p'],
	},
	canBeInColumn: true,
	canBeInContainer: true,
	supportsBorderRadius: true,
	focusOnInsert: true,
	createDefaultColumnItem: () =>
		({
			html: '',
			blockType: 'paragraph',
			fontSize: 14,
			textColor: '#374151',
			paddingTop: defaultPadding.paddingTop,
			paddingRight: 0,
			paddingBottom: defaultPadding.paddingBottom,
			paddingLeft: 0,
			paddingLinked: false,
			marginTop: 0,
			marginRight: 0,
			marginBottom: 0,
			marginLeft: 0,
		}) as TextBlockContent,
};
