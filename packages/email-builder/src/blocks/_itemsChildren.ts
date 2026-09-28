/**
 * Shared child helpers for the blocks that hold an `items` list of container
 * children (container, hero). Both surface the same panel rows and accept the
 * same child types, so the answer lives here once.
 */
import type { NestedChild } from './_module';
import type { BlockType, ContainerItem } from '../types';
import { editorModuleFor, getAllEditorModules } from './_registry';

/** Project a block's `items` into the flat list the `NestedItemsEditor` panel shows. */
export function itemsChildrenView(block: { content: { items?: ContainerItem[] } }): NestedChild[] {
	return (block.content.items ?? []).map((item) => {
		const mod = editorModuleFor(item.type as BlockType);
		return {
			id: item.id,
			type: item.type,
			label: mod?.label ?? item.type,
			icon: mod?.icon ?? null,
		};
	});
}

/** Block types that may be inserted as a container-placement child. */
export function containerChildTypes(): string[] {
	return getAllEditorModules()
		.filter((m) => m.canBeInContainer)
		.map((m) => m.type);
}
