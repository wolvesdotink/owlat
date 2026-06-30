export type SupportLevel = 'full' | 'partial' | 'none' | 'buggy';

/**
 * Rendering engine used by an email client.
 * Understanding the engine explains WHY features aren't supported.
 */
export type RenderEngine = 'webkit' | 'blink' | 'gecko' | 'word' | 'proprietary';

/**
 * Email client metadata with rendering engine and market share.
 */
export interface EmailClientInfo {
	name: string;
	renderEngine: RenderEngine;
	/** Approximate global market share percentage (updated periodically) */
	marketSharePercent: number;
}

/**
 * Degradation impact classification for unsupported features.
 */
export type DegradationImpact = 'visual' | 'functional' | 'hidden';

export interface ClientSupport {
	gmail: SupportLevel;
	gmailApp: SupportLevel;
	/** Outlook Desktop (Classic) — uses Word rendering engine */
	outlookDesktop: SupportLevel;
	/** Outlook 365 web — uses Word rendering engine */
	outlook365: SupportLevel;
	/** New Outlook for Windows — uses Edge/WebView2 (modern CSS) */
	outlookNew: SupportLevel;
	outlookMac: SupportLevel;
	appleMail: SupportLevel;
	iosMail: SupportLevel;
	yahooMail: SupportLevel;
	samsungMail: SupportLevel;
	thunderbird: SupportLevel;
	protonMail: SupportLevel;
}

/**
 * Actionable fix suggestion that the builder UI can act on.
 */
export interface CompatibilityFix {
	action: 'set-fallback' | 'remove-property' | 'replace-value' | 'add-property';
	property: string;
	suggestedValue?: string;
	description: string;
}

export interface FeatureCompatibility {
	feature: string;
	description: string;
	support: ClientSupport;
	fallback: string;
	owlatHandled: boolean;
	/** Impact when feature is unsupported */
	degradationImpact?: DegradationImpact;
	/** Link to Can I Email feature slug for live data */
	canIEmailSlug?: string;
	/** When this feature was last tested by Can I Email */
	lastTestedDate?: string;
	/** Notes from Can I Email per client */
	canIEmailNotes?: Record<string, string[]>;
}

/**
 * Per-property compatibility data for fine-grained builder UI hints.
 * Declared inside a Block module under `compatibility.properties` — the
 * owning block type is implied by the module and never stored on the entry.
 */
export interface PropertyCompatibility {
	property: string;
	description: string;
	support: ClientSupport;
	severity: 'critical' | 'warning' | 'info';
	recommendation: string;
	owlatHandled: boolean;
	/** Impact when property is unsupported */
	degradationImpact?: DegradationImpact;
	/** Actionable fix suggestions for the builder UI */
	fixes?: CompatibilityFix[];
}

/**
 * Result of a block-level composite compatibility assessment.
 */
export interface BlockCompatibilityScore {
	/** Overall score (0-100, higher = more compatible) */
	score: number;
	/** Clients with full support for the block's configuration */
	fullSupportClients: (keyof ClientSupport)[];
	/** Clients with partial or buggy support */
	partialSupportClients: (keyof ClientSupport)[];
	/** Critical issues that may hide content or break functionality */
	criticalIssues: string[];
}
