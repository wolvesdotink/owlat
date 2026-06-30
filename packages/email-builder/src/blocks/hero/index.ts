import { RectangleHorizontal } from '@lucide/vue';
import type { EditorModule, NestedChild } from '../_module';
import type { BlockType } from '../../types';
import { heroSchema } from '../../schema/definitions/hero';
import { editorModuleFor, getAllEditorModules } from '../_registry';

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

	childrenView(block): NestedChild[] {
		return (block.content.items ?? []).map((item) => {
			const mod = editorModuleFor(item.type as BlockType);
			return {
				id: item.id,
				type: item.type,
				label: mod?.label ?? item.type,
				icon: mod?.icon ?? null,
			};
		});
	},

	allowedChildTypes() {
		return getAllEditorModules()
			.filter((m) => m.canBeInContainer)
			.map((m) => m.type);
	},
};
