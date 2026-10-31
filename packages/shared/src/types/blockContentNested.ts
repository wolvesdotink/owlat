/**
 * Content types of the email editor blocks that nest other blocks or links:
 * container, social and hero.
 *
 * Import from `blocks.ts`, which re-exports everything here.
 */

import type {
	BorderStyle,
	ConditionalOption,
	CssClassOption,
	DarkModeOverrides,
	FullWidthOption,
	GradientBackground,
	ResponsiveVisibility,
} from './blockOptions';
import type {
	ButtonBlockContent,
	ColumnsBlockContent,
	DividerBlockContent,
	ImageBlockContent,
	SpacerBlockContent,
	TextBlockContent,
} from './blockContentBasic';

/**
 * Container item types - blocks that can be nested inside containers
 */
export type ContainerItemType =
	| 'text'
	| 'image'
	| 'button'
	| 'divider'
	| 'spacer'
	| 'columns'
	| 'social'
	| 'container';

/**
 * Container item content - all content types that can be nested in containers
 * Note: ContainerBlockContent is forward-referenced for recursive nesting
 */
export type ContainerItemContent =
	| TextBlockContent
	| ImageBlockContent
	| ButtonBlockContent
	| DividerBlockContent
	| SpacerBlockContent
	| ColumnsBlockContent
	| SocialBlockContent
	| ContainerBlockContent;

/**
 * A container item is a block nested inside a container
 */
export interface ContainerItem {
	id: string;
	type: ContainerItemType;
	content: ContainerItemContent;
}

/**
 * Container block content - groups multiple blocks with shared styling
 */
export interface ContainerBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	items: ContainerItem[];
	maxWidth: number;
	paddingTop: number;
	paddingRight: number;
	paddingBottom: number;
	paddingLeft: number;
	paddingLinked: boolean;
	marginTop: number;
	marginRight: number;
	marginBottom: number;
	marginLeft: number;
	backgroundColor?: string;
	borderWidth: number;
	borderColor: string;
	borderStyle: BorderStyle;
	borderRadius: number;
	/** Background image URL for hero-like sections */
	backgroundImage?: string;
	/** Background image position */
	backgroundPosition?: 'top' | 'center' | 'bottom';
	/** Background image size */
	backgroundSize?: 'cover' | 'contain';
	/** Gradient background (CSS linear-gradient with VML fallback) */
	backgroundGradient?: GradientBackground;
}

/**
 * Social link types
 */
export type SocialPlatform =
	| 'twitter'
	| 'facebook'
	| 'instagram'
	| 'linkedin'
	| 'youtube'
	| 'tiktok'
	| 'github'
	| 'whatsapp'
	| 'telegram'
	| 'threads'
	| 'pinterest'
	| 'discord'
	| 'mastodon'
	| 'bluesky'
	| 'vimeo'
	| 'medium'
	| 'snapchat';

/**
 * Exhaustive metadata for every {@link SocialPlatform}.
 *
 * Keying this `Record` on the `SocialPlatform` union makes a newly-added
 * platform a compile error here (and on every surface that derives its labels
 * from this map), so display names can never silently fall out of sync.
 *
 * - `label` — the canonical display/rendering name (e.g. Twitter renders as 'X').
 * - `editorLabel` — optional override for the block-editor platform picker
 *   (e.g. Twitter shows 'Twitter / X' so authors recognise the legacy name).
 */
export const SOCIAL_PLATFORMS: Record<SocialPlatform, { label: string; editorLabel?: string }> = {
	twitter: { label: 'X', editorLabel: 'Twitter / X' },
	facebook: { label: 'Facebook' },
	instagram: { label: 'Instagram' },
	linkedin: { label: 'LinkedIn' },
	youtube: { label: 'YouTube' },
	tiktok: { label: 'TikTok' },
	github: { label: 'GitHub' },
	whatsapp: { label: 'WhatsApp' },
	telegram: { label: 'Telegram' },
	threads: { label: 'Threads' },
	pinterest: { label: 'Pinterest' },
	discord: { label: 'Discord' },
	mastodon: { label: 'Mastodon' },
	bluesky: { label: 'Bluesky' },
	vimeo: { label: 'Vimeo' },
	medium: { label: 'Medium' },
	snapchat: { label: 'Snapchat' },
};

/**
 * Social link
 */
export interface SocialLink {
	platform: SocialPlatform;
	url: string;
	enabled: boolean;
	/** Custom icon URL */
	iconUrl?: string;
}

/**
 * Social block content
 */
export interface SocialBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	links: SocialLink[];
	iconStyle: 'filled' | 'outline';
	align: 'left' | 'center' | 'right';
	iconSize: number;
	iconSpacing: number;
	iconColor: string;
	/** Layout mode: horizontal or vertical */
	mode?: 'horizontal' | 'vertical';
	/** Show platform name text labels */
	showLabels?: boolean;
	paddingTop?: number;
	paddingRight?: number;
	paddingBottom?: number;
	paddingLeft?: number;
	paddingLinked?: boolean;
	marginTop?: number;
	marginRight?: number;
	marginBottom?: number;
	marginLeft?: number;
	backgroundColor?: string;
	borderWidth?: number;
	borderColor?: string;
	borderStyle?: BorderStyle;
}

/**
 * Hero block content - full-width background image with overlaid text + CTA
 */
export interface HeroBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	backgroundImage: string;
	backgroundPosition: 'top' | 'center' | 'bottom';
	backgroundSize: 'cover' | 'contain';
	height: number;
	mode: 'fixed-height' | 'fluid-height';
	verticalAlign: 'top' | 'middle' | 'bottom';
	overlayColor?: string;
	backgroundColor?: string;
	/** Gradient background (CSS linear-gradient with VML fallback) */
	backgroundGradient?: GradientBackground;
	items: ContainerItem[];
	paddingTop?: number;
	paddingRight?: number;
	paddingBottom?: number;
	paddingLeft?: number;
	paddingLinked?: boolean;
	marginTop?: number;
	marginRight?: number;
	marginBottom?: number;
	marginLeft?: number;
	borderRadius?: number;
	borderWidth?: number;
	borderColor?: string;
	borderStyle?: BorderStyle;
}
