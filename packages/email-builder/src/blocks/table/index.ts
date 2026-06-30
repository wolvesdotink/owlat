import { Table } from '@lucide/vue';
import type { EditorModule } from '../_module';
import { tableSchema } from '../../schema/definitions/table';

export const tableEditor: EditorModule<'table'> = {
	type: 'table',
	label: 'Table',
	icon: Table,
	schema: tableSchema,
	slashCommand: {
		name: 'Table',
		description: 'Data table with headers and rows',
		category: 'layout',
		aliases: ['grid', 'data', 'spreadsheet'],
	},
	canBeInColumn: false,
	canBeInContainer: false,
};
