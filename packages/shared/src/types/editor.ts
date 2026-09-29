import type {
	BlockType,
	BlockTypeContentMap,
	ButtonBlockContent,
	TextBlockContent,
} from './blocks';

/**
 * Email theme configuration / design tokens. Every field is optional; the
 * value used when one is unset lives in one place.
 *
 * @see DEFAULT_EMAIL_THEME in `@owlat/shared/emailDefaults`
 */
export interface EmailTheme {
	/** Primary brand color */
	primaryColor?: string;
	/** Font family */
	fontFamily?: string;
	/** Background color */
	backgroundColor?: string;
	/** Heading font family (falls back to fontFamily) */
	headingFontFamily?: string;
	/** Body font size in px */
	bodyFontSize?: number;
	/** Body text color */
	bodyTextColor?: string;
	/** Link color */
	linkColor?: string;
	/** Global default border radius in px */
	borderRadius?: number;
	/** Base spacing multiplier in px */
	spacingUnit?: number;
	/** Default button styles merged into all button blocks */
	buttonDefaults?: Partial<
		Pick<
			ButtonBlockContent,
			| 'backgroundColor'
			| 'textColor'
			| 'borderRadius'
			| 'fontSize'
			| 'fontFamily'
			| 'fontWeight'
			| 'paddingX'
			| 'paddingY'
		>
	>;
	/** Default heading styles per level */
	headingDefaults?: Partial<
		Record<
			'h1' | 'h2' | 'h3',
			Partial<
				Pick<
					TextBlockContent,
					'fontSize' | 'fontWeight' | 'textColor' | 'lineHeight' | 'letterSpacing'
				>
			>
		>
	>;
	/**
	 * Global defaults for any block type (mj-attributes equivalent).
	 * Properties are shallow-merged into block content before rendering.
	 * Block-level values always override these defaults.
	 */
	blockDefaults?: { [K in BlockType]?: Partial<BlockTypeContentMap[K]> };
	/** Dark mode background color */
	darkModeBackgroundColor?: string;
	/** Dark mode text color */
	darkModeTextColor?: string;
	/** Dark mode link color */
	darkModeLinkColor?: string;
	/** Base content width in px (min: 400, max: 800). Affects layout, columns, and VML. */
	baseWidth?: number;
}
