/**
 * Resolves a PropertyGroup to its coolicons component.
 *
 * Shared groups already carry an `icon` string (e.g. 'Move', 'Square').
 * Block-specific groups (Content, Typography, Style, etc.) don't.
 * This utility maps both cases to concrete coolicons components.
 */
import type { Component } from 'vue';
import {
	DatabaseIcon,
	FileTextIcon,
	GridIcon,
	ImageIcon,
	LayersIcon,
	LinkHorizontalIcon,
	ListOrderedIcon,
	MobileIcon,
	MoonIcon,
	MoveIcon,
	PaletteIcon,
	SettingsIcon,
	SquareIcon,
	TagIcon,
	TextIcon,
	ToggleLeftIcon,
} from '@coolicons/vue';

/** Name → component map (covers shared group `icon` strings + label-based lookups) */
const iconMap: Record<string, Component> = {
	// Shared group icon strings
	Move: MoveIcon,
	Square: SquareIcon,
	Moon: MoonIcon,
	Smartphone: MobileIcon,
	Settings: SettingsIcon,

	// Label-based mappings
	Content: FileTextIcon,
	Typography: TextIcon,
	Style: PaletteIcon,
	Layout: GridIcon,
	'Button Border': SquareIcon,
	Border: SquareIcon,
	Retina: ImageIcon,
	Dark: ImageIcon,
	'Dark Mode': MoonIcon,
	Links: LinkHorizontalIcon,
	Background: ImageIcon,
	Mobile: MobileIcon,
	Responsive: MobileIcon,
	Labels: TagIcon,
	Label: TagIcon,
	Data: DatabaseIcon,
	Images: ImageIcon,
	Sections: LayersIcon,
	Items: ListOrderedIcon,
	Behavior: ToggleLeftIcon,
	Spacing: MoveIcon,
	Advanced: SettingsIcon,
};

/**
 * Resolve a PropertyGroup's icon to a coolicons component.
 *
 * Priority: `group.icon` string → `group.label` match → fallback `Settings`.
 */
export function resolveGroupIcon(group: { label: string; icon?: string }): Component {
	if (group.icon && iconMap[group.icon]) {
		return iconMap[group.icon]!;
	}
	return iconMap[group.label] ?? SettingsIcon;
}
