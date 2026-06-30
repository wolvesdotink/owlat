import type { EmailTheme, VariableType } from '@owlat/shared';

/**
 * Target email client for render preview simulation.
 * Degrades the output to approximate how a specific client would render the email.
 */
export type TargetClient =
	| 'gmail'
	| 'outlookDesktop'
	| 'outlookNew'
	| 'appleMail'
	| 'yahooMail';

/**
 * Validation strictness level.
 * - 'skip': No validation (production performance)
 * - 'soft': Collect warnings but don't throw (development default)
 * - 'strict': Throw on error-level validation issues
 */
export type ValidationLevel = 'skip' | 'soft' | 'strict';

export interface RenderOptions {
	theme?: EmailTheme;
	darkMode?: boolean;
	variableType?: VariableType;
	minify?: boolean;
	/** Hidden preview text shown in inbox after subject line */
	preheaderText?: string;
	/** Document title (shown in browser tab if email is viewed in browser) */
	title?: string;
	/** Responsive breakpoint in px (default: 480) */
	breakpoint?: number;
	/** Text direction for RTL language support */
	direction?: 'ltr' | 'rtl';
	/** Web font URLs to import (Google Fonts, etc.) */
	fontUrls?: string[];
	/** Custom CSS injected into the <style> block */
	customCss?: string;
	/** Variable values for conditional content evaluation */
	variableValues?: Record<string, string>;
	/** Language for the HTML document (default: 'en') */
	lang?: string;
	/** Transform function applied to all link URLs before rendering (UTM, click tracking) */
	linkTransform?: (url: string, context: { blockType: string; blockId: string }) => string;
	/** Callback invoked for non-fatal rendering warnings */
	onWarning?: (msg: string) => void;
	/** Inline CSS onto elements for maximum client compatibility (default: true) */
	inlineCss?: boolean;
	/** Base content width in px (default: 600). Affects layout, columns, and VML. */
	baseWidth?: number;
	/**
	 * Simulate rendering for a specific email client.
	 * Post-processes HTML to approximate client behavior (e.g. Gmail strips <style>,
	 * Outlook ignores border-radius). Useful for development previews.
	 */
	targetClient?: TargetClient;
	/** Validation strictness level (default: 'soft') */
	validationLevel?: ValidationLevel;
	/** Gmail Promotions tab annotations (Schema.org/JSON-LD). Only affects Gmail (~30-40% of opens). */
	gmailAnnotations?: GmailAnnotations;
}

/**
 * Gmail Promotions tab annotations using Schema.org JSON-LD.
 * Enables rich cards in Gmail's Promotions tab (images, deals, promo codes).
 */
export interface GmailAnnotations {
	/** URL of the logo image (minimum 144x144, square recommended) */
	logo?: string;
	/** Description text shown in the promotion card */
	description?: string;
	/** Discount code (e.g., "SAVE20") */
	discountCode?: string;
	/** Availability end date (ISO 8601 format) */
	availabilityEnds?: string;
	/** Featured image URL for the promotion card */
	image?: string;
	/** Deal description (e.g., "20% off") */
	dealDescription?: string;
}

export interface EmailHealthRecommendation {
	category: 'compatibility' | 'accessibility' | 'deliverability' | 'outlook';
	message: string;
	impact: 'high' | 'medium' | 'low';
}

export interface EmailHealthScore {
	/** Overall weighted composite score (0-100) */
	overall: number;
	/** Compatibility score from scoreBlockCompatibility */
	compatibility: number;
	/** Accessibility score from validateBlocks(accessibilityAudit) */
	accessibility: number;
	/** Deliverability score based on size, text ratio, spam signals */
	deliverability: number;
	/** Outlook-specific compatibility score */
	outlookSupport: number;
	/** Actionable recommendations grouped by category */
	recommendations: EmailHealthRecommendation[];
}

export interface RenderContext {
	theme: Required<Pick<EmailTheme, 'primaryColor' | 'fontFamily' | 'backgroundColor'>> & EmailTheme;
	darkMode: boolean;
	variableType: VariableType;
	variableClass: string;
	baseWidth: number;
	preheaderText: string;
	title: string;
	breakpoint: number;
	direction: 'ltr' | 'rtl';
	fontUrls: string[];
	customCss: string;
	variableValues: Record<string, string>;
	/** Language for the HTML document (default: 'en') */
	lang: string;
	/** Collected responsive CSS rules injected into mobile media query */
	responsiveRules: string[];
	/** Collected global CSS rules injected into <style> block outside any media query */
	globalRules: string[];
	/** Link URL transform function for UTM/tracking rewriting */
	linkTransform?: (url: string, context: { blockType: string; blockId: string }) => string;
	/** Warnings emitted during rendering */
	warnings: string[];
	/** Gmail Promotions tab JSON-LD annotations */
	gmailAnnotations?: GmailAnnotations;
}
