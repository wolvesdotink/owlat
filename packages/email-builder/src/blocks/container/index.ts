import { Square } from '@lucide/vue';
import { moduleFor } from '@owlat/email-renderer';
import type { EditorModule, NestedChild } from '../_module';
import type { BlockType, ContainerBlockContent } from '../../types';
import { containerSchema } from '../../schema/definitions/container';
import { editorModuleFor, getAllEditorModules } from '../_registry';

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
	createDefault: (theme) =>
		moduleFor('container')!.createDefault!(theme) as ContainerBlockContent,

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
