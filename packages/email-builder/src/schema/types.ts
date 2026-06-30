/**
 * Block Attribute Schema System
 *
 * Defines the shape of the property panel for each block type.
 * A single schema definition (~50 lines) replaces a renderer + controls component (~350 lines).
 */

/**
 * Supported field types for the property panel.
 */
export type FieldType =
	| 'text'
	| 'textarea'
	| 'richtext'
	| 'number'
	| 'slider'
	| 'color'
	| 'select'
	| 'toggle'
	| 'url'
	| 'date'
	| 'image'
	| 'align'
	| 'spacing'
	| 'margin'
	| 'border'
	| 'gradient'
	| 'array'
	| 'condition'
	| 'repeat'
	| 'fontFamily';

/**
 * A single property field in the panel.
 * Maps to `block.content[key]` for reads/writes.
 */
export interface PropertyField {
	/** Key path into block.content (e.g. 'text', 'backgroundColor') */
	key: string;
	/** Display label */
	label: string;
	/** Field renderer type */
	type: FieldType;

	// --- Type-specific options ---

	/** Minimum value (number/slider) */
	min?: number;
	/** Maximum value (number/slider) */
	max?: number;
	/** Step increment (number/slider) */
	step?: number;
	/** Unit label (e.g. 'px', '%') */
	unit?: string;
	/** Options for 'select' fields */
	options?: { label: string; value: string | number | boolean }[];
	/** Alignment options for 'align' fields (defaults to left/center/right) */
	alignOptions?: ('left' | 'center' | 'right' | 'justify' | 'full')[];
	/** Sub-field schema for 'array' items */
	itemSchema?: PropertyField[];
	/** Factory for new array items */
	itemDefault?: () => Record<string, unknown>;
	/** Conditional visibility — only show this field when another field matches a value */
	showWhen?: { key: string; value: unknown };
	/** Placeholder text */
	placeholder?: string;
	/** Help text shown below the field */
	helpText?: string;
	/** Show this field in the floating toolbar */
	toolbar?: boolean;
}

/**
 * A group of related fields shown as a collapsible section.
 */
export interface PropertyGroup {
	/** Section heading */
	label: string;
	/** Lucide icon name (optional) */
	icon?: string;
	/** Default collapsed state */
	collapsed?: boolean;
	/** Fields in this group */
	fields: PropertyField[];
}

/**
 * Complete schema for a block type's property panel.
 */
export interface BlockAttributeSchema {
	/** Block type identifier (must match BlockType) */
	type: string;
	/** Display label */
	label: string;
	/** Property groups (rendered as collapsible sections) */
	groups: PropertyGroup[];
	/** Field keys to show in toolbar (alternative to marking individual fields) */
	toolbarFields?: string[];
}
