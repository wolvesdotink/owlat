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
 * A block inside a container, hero or accordion section: text, image, button,
 * divider, spacer, columns, social or another container.
 */
export interface ContainerItem {
	id: string;
	type: ContainerItemType;
	content: ContainerItemContent;
}

/**
 * A group of blocks with a shared background, border and padding.
 */
export interface ContainerBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	/** The blocks inside the container, top to bottom. */
	items: ContainerItem[];
	/** Maximum width in px. */
	maxWidth: number;
	paddingTop: number;
	paddingRight: number;
	paddingBottom: number;
	paddingLeft: number;
	/** @writeOptional the renderer does not read it */
	paddingLinked: boolean;
	/** @writeOptional a missing margin renders as 0 */
	marginTop: number;
	/** @writeOptional a missing margin renders as 0 */
	marginRight: number;
	/** @writeOptional a missing margin renders as 0 */
	marginBottom: number;
	/** @writeOptional a missing margin renders as 0 */
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
 * One platform's profile link.
 */
export interface SocialLink {
	platform: SocialPlatform;
	/** Profile URL. A link without one is not shown. */
	url: string;
	/** Whether the icon is shown. */
	enabled: boolean;
	/** Custom icon URL */
	iconUrl?: string;
}

/**
 * A row of social profile icons.
 */
export interface SocialBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	links: SocialLink[];
	/** Which set of the built-in icons to use. */
	iconStyle: 'filled' | 'outline';
	align: 'left' | 'center' | 'right';
	/** Icon size in px. */
	iconSize: number;
	/** Space between icons in px. */
	iconSpacing: number;
	/** Icon color (CSS color). */
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
 * A background image with blocks laid over it, such as a headline and a button.
 */
export interface HeroBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	/** Background image URL (https). */
	backgroundImage: string;
	backgroundPosition: 'top' | 'center' | 'bottom';
	backgroundSize: 'cover' | 'contain';
	/** Height in px; with `fluid-height` the content may grow past it. */
	height: number;
	mode: 'fixed-height' | 'fluid-height';
	/** Where the blocks sit within the height. */
	verticalAlign: 'top' | 'middle' | 'bottom';
	/** Color laid over the image, for contrast (CSS color, may be translucent). */
	overlayColor?: string;
	backgroundColor?: string;
	/** Gradient background (CSS linear-gradient with VML fallback) */
	backgroundGradient?: GradientBackground;
	/** The blocks laid over the image, top to bottom. */
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
