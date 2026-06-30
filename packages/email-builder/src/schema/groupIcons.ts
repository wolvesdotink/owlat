/**
 * Resolves a PropertyGroup to its Lucide icon component.
 *
 * Shared groups already carry an `icon` string (e.g. 'Move', 'Square').
 * Block-specific groups (Content, Typography, Style, etc.) don't.
 * This utility maps both cases to concrete Lucide components.
 */
import type { Component } from 'vue';
import {
	FileText,
	Type,
	Palette,
	LayoutGrid,
	Square,
	ImageIcon,
	Link2,
	Smartphone,
	Tag,
	Database,
	Layers,
	ListOrdered,
	ToggleLeft,
	Move,
	Moon,
	Settings,
} from '@lucide/vue';

/** Name → component map (covers shared group `icon` strings + label-based lookups) */
const iconMap: Record<string, Component> = {
	// Shared group icon strings
	Move,
	Square,
	Moon,
	Smartphone,
	Settings,

	// Label-based mappings
	Content: FileText,
	Typography: Type,
	Style: Palette,
	Layout: LayoutGrid,
	'Button Border': Square,
	Border: Square,
	Retina: ImageIcon,
	Dark: ImageIcon,
	'Dark Mode': Moon,
	Links: Link2,
	Background: ImageIcon,
	Mobile: Smartphone,
	Responsive: Smartphone,
	Labels: Tag,
	Label: Tag,
	Data: Database,
	Images: ImageIcon,
	Sections: Layers,
	Items: ListOrdered,
	Behavior: ToggleLeft,
	Spacing: Move,
	Advanced: Settings,
};

/**
 * Resolve a PropertyGroup's icon to a Lucide component.
 *
 * Priority: `group.icon` string → `group.label` match → fallback `Settings`.
 */
export function resolveGroupIcon(group: { label: string; icon?: string }): Component {
	if (group.icon && iconMap[group.icon]) {
		return iconMap[group.icon]!;
	}
	return iconMap[group.label] ?? Settings;
}
