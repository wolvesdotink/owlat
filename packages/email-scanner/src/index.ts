/**
 * @owlat/email-scanner
 *
 * Email security scanning package providing multi-layered defense:
 *
 * 1. **Content Scanning** (pure TS, zero deps — safe for any JS runtime)
 *    - Spam keyword detection with weighted scoring
 *    - Phishing URL detection (typosquatting, suspicious TLDs, URL shorteners)
 *    - Homoglyph/Unicode spoofing detection
 *    - Prohibited content patterns (419 scams, credential phishing)
 *    - Subject line analysis (caps abuse, excessive punctuation)
 *
 * 2. **File Validation** (pure TS, zero deps)
 *    - Magic bytes detection (identifies real file type from binary header)
 *    - Double extension detection (e.g., "invoice.pdf.exe")
 *    - Configurable file policy engine (allowlist-based)
 *
 * 3. **URL Reputation** (requires `fetch`)
 *    - Google Safe Browsing API v4 integration
 *    - Abstract caching interface (implement with your storage backend)
 *
 * 4. **ClamAV Integration** (requires Node.js `net` module — MTA only)
 *    - TCP client for clamd INSTREAM protocol
 *    - Connection pooling and health checking
 *    - Fail-open design for resilience
 *
 * @example
 * ```typescript
 * import { scanContent } from '@owlat/email-scanner';
 *
 * const result = scanContent('Subject', '<html>...</html>');
 * if (result.level === 'blocked') {
 *   // Reject the email
 * }
 * ```
 */

// ============ TYPES ============
export type {
	ContentFlag,
	ContentFlagType,
	ContentFlagSeverity,
	ContentScanResult,
	ContentScanLevel,
	FileValidationResult,
	FilePolicy,
	UrlVerdict,
	UrlReputationResult,
	CachedVerdict,
	UrlReputationCache,
	ClamScanResult,
	ClamClientOptions,
	EnhancedScanOptions,
	EnhancedScanResult,
} from './types.js';

// ============ CONTENT SCANNING ============
export {
	scanContent,
	levelForScore,
	scanSpamKeywords,
	scanPhishingUrls,
	scanHomoglyphs,
	scanProhibitedContent,
	scanCapsAbuse,
	scanExcessivePunctuation,
	scanSenderImpersonation,
	extractHeaderDomain,
	registrableDomain,
	extractUrls,
	extractDomain,
	deconfuse,
	contentRules,
	registerContentRule,
	unregisterContentRule,
} from './content/index.js';
export type { ContentScanRule, ScanInput } from './content/index.js';

// ============ FILE VALIDATION ============
export {
	validateFile,
	fileValidationToFlags,
	detectFileType,
	isDangerousFileType,
	detectDoubleExtension,
	isExecutableExtension,
	DEFAULT_FILE_POLICY,
	isMimeTypeAllowed,
	isExtensionAllowed,
	isFileSizeAllowed,
	mergePolicy,
} from './files/index.js';

// ============ URL REPUTATION ============
export {
	checkUrlReputation,
	checkUrlReputationBatch,
	urlReputationToFlags,
	checkSafeBrowsing,
	hashUrl,
	normalizeUrl,
	createCachedVerdict,
	isExpired,
	InMemoryUrlCache,
	CLEAN_TTL_MS,
	FLAGGED_TTL_MS,
} from './urls/index.js';

// Note: ClamAV exports are NOT included here because they require Node.js `net` module.
// Import from '@owlat/email-scanner/clamav' directly in Node.js environments (MTA).
