import { Columns } from '@lucide/vue';
import type { EditorModule, NestedChild } from '../_module';
import type { BlockType } from '../../types';
import { columnsSchema } from '../../schema/definitions/columns';
import { editorModuleFor, getAllEditorModules } from '../_registry';

export const columnsEditor: EditorModule<'columns'> = {
	type: 'columns',
	label: 'Columns',
	icon: Columns,
	schema: columnsSchema,
	slashCommand: {
		name: 'Columns',
		description: 'Side-by-side layout',
		category: 'layout',
		aliases: ['cols', 'grid', 'layout'],
	},
	canBeInColumn: false,
	canBeInContainer: true,
	supportsBorderRadius: true,

	childrenView(block): NestedChild[] {
		return block.content.columns.flatMap((col, colIdx) =>
			col.map((item) => {
				const mod = editorModuleFor(item.type as BlockType);
				return {
					id: item.id,
					type: item.type,
					label: `Col ${colIdx + 1}: ${mod?.label ?? item.type}`,
					icon: mod?.icon ?? null,
				};
			}),
		);
	},

	allowedChildTypes() {
		return getAllEditorModules()
			.filter((m) => m.canBeInColumn)
			.map((m) => m.type);
	},
};
