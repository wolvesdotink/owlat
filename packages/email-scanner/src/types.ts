/**
 * Email Scanner — Shared Types
 *
 * Types for scan results, content flags, and scanner options used across
 * all scanning modules (content, files, URLs, ClamAV).
 */

// ============ CONTENT FLAGS ============

export type ContentFlagType =
	| 'spam_keywords'
	| 'phishing_url'
	| 'url_shortener'
	| 'url_mismatch'
	| 'prohibited_content'
	| 'caps_abuse'
	| 'excessive_punctuation'
	| 'suspicious_pattern'
	// New flag types
	| 'homoglyph_spoofing'
	| 'malicious_url'
	| 'dangerous_file_type'
	| 'attachment_malware'
	// Sender-authenticity flags (Sealed Mail A4): raised over the message
	// headers rather than the body — a From domain that homoglyph/punycode
	// spoofs a real domain, or a Reply-To that points at a different domain
	// than the visible From (a classic reply-hijack setup).
	| 'sender_impersonation'
	| 'reply_to_mismatch';

export type ContentFlagSeverity = 'low' | 'medium' | 'high';

export interface ContentFlag {
	type: ContentFlagType;
	severity: ContentFlagSeverity;
	description: string;
	/** The matched content (for debugging) */
	match?: string;
}

// ============ CONTENT SCAN RESULTS ============

export type ContentScanLevel = 'clean' | 'suspicious' | 'blocked';

export interface ContentScanResult {
	/** 0-100 spam score */
	score: number;
	/** Whether the content passes (score below threshold) */
	pass: boolean;
	/** Individual issues found */
	flags: ContentFlag[];
	/** Overall scan level */
	level: ContentScanLevel;
}

// ============ FILE VALIDATION ============

export interface FileValidationResult {
	/** Whether the file is allowed */
	allowed: boolean;
	/** Detected file type (e.g., 'application/x-msdownload', 'image/png') */
	detectedType: string;
	/** Human-readable reason if blocked */
	reason?: string;
	/** Whether a dangerous file type was detected via magic bytes */
	dangerousType?: boolean;
	/** Whether a double extension was detected */
	doubleExtension?: boolean;
}

export interface FilePolicy {
	/** Allowed MIME type prefixes (e.g., ['image/', 'application/pdf']) */
	allowedTypes: string[];
	/** Allowed file extensions (e.g., ['.jpg', '.png', '.pdf']) */
	allowedExtensions: string[];
	/** Max file size in bytes (optional) */
	maxFileSize?: number;
}

// ============ URL REPUTATION ============

export type UrlVerdict = 'safe' | 'malicious' | 'suspicious';

export interface UrlReputationResult {
	url: string;
	verdict: UrlVerdict;
	source: string;
	threats?: string[];
}

export interface CachedVerdict {
	verdict: UrlVerdict;
	source: string;
	threats?: string[];
	checkedAt: number;
	expiresAt: number;
}

/**
 * Abstract cache interface for URL reputation verdicts.
 * Convex implements this with a DB table, MTA could use Redis.
 */
export interface UrlReputationCache {
	get(urlHash: string): Promise<CachedVerdict | null>;
	set(urlHash: string, verdict: CachedVerdict): Promise<void>;
}

// ============ CLAMAV ============

export interface ClamScanResult {
	/** Whether the content is clean (no malware detected) */
	clean: boolean;
	/** Virus/malware name if detected */
	virus?: string;
	/** Whether the scan was skipped (e.g., ClamAV unreachable) */
	skipped?: boolean;
	/** Error message if scan failed */
	error?: string;
}

export interface ClamClientOptions {
	/** ClamAV daemon host (default: 'localhost') */
	host?: string;
	/** ClamAV daemon port (default: 3310) */
	port?: number;
	/** Connection timeout in ms (default: 5000) */
	connectTimeout?: number;
	/** Scan timeout in ms (default: 30000) */
	scanTimeout?: number;
	/** Number of pooled connections (default: 3) */
	poolSize?: number;
	/** Whether to fail open if ClamAV is unreachable (default: true) */
	failOpen?: boolean;
	/** Logger function (default: console.warn) */
	logger?: (
		level: 'info' | 'warn' | 'error',
		message: string,
		meta?: Record<string, unknown>
	) => void;
}

// ============ ENHANCED SCAN OPTIONS ============

export interface EnhancedScanOptions {
	/** Whether to check URL reputation via external APIs */
	checkUrlReputation?: boolean;
	/** Google Safe Browsing API key */
	safeBrowsingApiKey?: string;
	/** URL reputation cache implementation */
	urlCache?: UrlReputationCache;
	/** Attachments to validate (filename + first bytes) */
	attachments?: Array<{
		filename: string;
		firstBytes?: Uint8Array;
		fullBuffer?: Buffer;
	}>;
	/** File policy overrides */
	filePolicy?: FilePolicy;
}

export interface EnhancedScanResult extends ContentScanResult {
	/** URL reputation results (if checked) */
	urlReputationResults?: UrlReputationResult[];
	/** File validation results (if attachments provided) */
	fileValidationResults?: FileValidationResult[];
	/** ClamAV scan results (if attachments scanned) */
	clamResults?: ClamScanResult[];
}
