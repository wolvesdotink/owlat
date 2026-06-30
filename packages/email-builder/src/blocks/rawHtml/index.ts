import { Code } from '@lucide/vue';
import type { EditorModule } from '../_module';
import { rawHtmlSchema } from '../../schema/definitions/rawHtml';

export const rawHtmlEditor: EditorModule<'rawHtml'> = {
	type: 'rawHtml',
	label: 'HTML',
	icon: Code,
	schema: rawHtmlSchema,
	slashCommand: {
		name: 'Raw HTML',
		description: 'Custom HTML code block',
		category: 'components',
		aliases: ['html', 'code', 'custom', 'embed'],
	},
	canBeInColumn: false,
	canBeInContainer: false,
};
