/**
 * Shared property field groups reused across block schemas.
 *
 * Blocks compose their schema by spreading these groups:
 *   groups: [contentGroup, styleGroup, ...sharedGroups]
 */
import type { PropertyGroup, PropertyField } from '../types';

// ---------------------------------------------------------------------------
// Reusable field definitions
// ---------------------------------------------------------------------------

export const paddingFields: PropertyField[] = [
	{ key: 'padding', label: 'Padding', type: 'spacing' },
];

export const marginFields: PropertyField[] = [
	{ key: 'margin', label: 'Margin', type: 'margin' },
];

export const backgroundColorField: PropertyField = {
	key: 'backgroundColor',
	label: 'Background Color',
	type: 'color',
};

export const borderRadiusField: PropertyField = {
	key: 'borderRadius',
	label: 'Border Radius',
	type: 'number',
	min: 0,
	max: 50,
	unit: 'px',
};

export const borderFields: PropertyField[] = [
	{ key: 'borderWidth', label: 'Border Width', type: 'number', min: 0, max: 10, unit: 'px' },
	{ key: 'borderColor', label: 'Border Color', type: 'color' },
	{
		key: 'borderStyle',
		label: 'Border Style',
		type: 'select',
		options: [
			{ label: 'Solid', value: 'solid' },
			{ label: 'Dashed', value: 'dashed' },
			{ label: 'Dotted', value: 'dotted' },
			{ label: 'None', value: 'none' },
		],
	},
];

// ---------------------------------------------------------------------------
// Shared groups
// ---------------------------------------------------------------------------

export const spacingGroup: PropertyGroup = {
	label: 'Spacing',
	icon: 'Move',
	collapsed: true,
	fields: [...paddingFields, ...marginFields],
};

export const borderGroup: PropertyGroup = {
	label: 'Border',
	icon: 'Square',
	collapsed: true,
	fields: [...borderFields, borderRadiusField],
};

/** Border group without border-radius (for blocks that don't support it) */
export const borderGroupNoBorderRadius: PropertyGroup = {
	label: 'Border',
	icon: 'Square',
	collapsed: true,
	fields: [...borderFields],
};

export const darkModeGroup: PropertyGroup = {
	label: 'Dark Mode',
	icon: 'Moon',
	collapsed: true,
	fields: [
		{ key: 'darkBackgroundColor', label: 'Dark Background', type: 'color' },
		{ key: 'darkTextColor', label: 'Dark Text Color', type: 'color' },
	],
};

export const responsiveGroup: PropertyGroup = {
	label: 'Responsive',
	icon: 'Smartphone',
	collapsed: true,
	fields: [
		{ key: 'hideOnMobile', label: 'Hide on Mobile', type: 'toggle' },
		{ key: 'hideOnDesktop', label: 'Hide on Desktop', type: 'toggle' },
	],
};

export const advancedGroup: PropertyGroup = {
	label: 'Advanced',
	icon: 'Settings',
	collapsed: true,
	fields: [
		{ key: 'fullWidth', label: 'Full Width', type: 'toggle' },
		{ key: 'cssClass', label: 'CSS Class', type: 'text', placeholder: 'custom-class' },
		{ key: 'condition', label: 'Condition', type: 'condition' },
		{ key: 'repeat', label: 'Repeat', type: 'repeat' },
	],
};

/** Advanced group without fullWidth option (for blocks that don't support it) */
export const advancedGroupNoFullWidth: PropertyGroup = {
	label: 'Advanced',
	icon: 'Settings',
	collapsed: true,
	fields: [
		{ key: 'cssClass', label: 'CSS Class', type: 'text', placeholder: 'custom-class' },
		{ key: 'condition', label: 'Condition', type: 'condition' },
		{ key: 'repeat', label: 'Repeat', type: 'repeat' },
	],
};

// ---------------------------------------------------------------------------
// Helper to compose shared groups for common block patterns
// ---------------------------------------------------------------------------

/** Standard shared groups: spacing + border (with radius) + dark mode + responsive + advanced */
export const standardSharedGroups: PropertyGroup[] = [
	spacingGroup,
	borderGroup,
	darkModeGroup,
	responsiveGroup,
];

/** Shared groups without border-radius */
export const sharedGroupsNoBorderRadius: PropertyGroup[] = [
	spacingGroup,
	borderGroupNoBorderRadius,
	darkModeGroup,
	responsiveGroup,
];

/** Shared groups without fullWidth */
export const sharedGroupsNoFullWidth: PropertyGroup[] = [
	spacingGroup,
	borderGroup,
	darkModeGroup,
	responsiveGroup,
];
