export * from './utils';
export * from './types';
export * from './featureFlags';
export * from './operatingModes';
export {
	type OperationErrorCategory,
	type OperationError,
	OPERATION_ERROR_CATEGORIES,
	categoryToHttpStatus,
	isOperationErrorCategory,
	isOperationError,
	extractOperationError,
} from './operationError';
export {
	type ParsedAddress,
	parseAddress,
	parseAddressList,
	extractDomain,
	extractDomainOrNull,
	normalizeEmail,
} from './address';
export { type AlignmentMode, isSpfAligned, emailDomain } from './spfAlignment';
export {
	type SendTransportKind,
	type OutboundAlignmentState,
	type OutboundTransportFacts,
	type FromAlignmentResult,
	type OutboundAlignmentSummary,
	checkFromAlignment,
	summarizeOutboundAlignment,
} from './transportAlignment';
export { type OutboundTlsMode, OUTBOUND_TLS_MODES, isOutboundTlsMode } from './outboundTlsMode';
export {
	type TlsRptPolicy,
	type TlsRptFailureDetail,
	type TlsRptPolicyBlock,
	type TlsRptReport,
	type TlsReportParseResult,
	type TlsReportDigest,
	TLS_RPT_MAX_COMPRESSED_BYTES,
	TLS_RPT_MAX_DECOMPRESSED_BYTES,
	TLS_RPT_FAILURE_EXPLANATIONS,
	gunzipTlsReport,
	parseTlsReport,
	decodeTlsReport,
	digestTlsReport,
	explainTlsFailureType,
} from './tlsReport';
export {
	type MtaStsMode,
	type MtaStsPublishedMode,
	MTA_STS_MODES,
	MTA_STS_MAX_AGE_SECONDS,
	MTA_STS_TXT_HOST,
	MTA_STS_POLICY_HOST,
	MTA_STS_WELL_KNOWN_PATH,
	MTA_STS_CONTENT_TYPE,
	type MtaStsVerification,
	isMtaStsMode,
	mtaStsPolicyId,
	buildMtaStsTxtValue,
	parseMtaStsTxtId,
	buildMtaStsPolicy,
	verifyMtaStsPublication,
} from './mtaStsPolicy';
export { isSpfRecord, parseSpfMechanisms, mergeSpfRecords } from './spf';
export type { ValidationIssue } from './validation';
export {
	emailClients,
	fullSupport,
	// Pluggable registries
	emailClientRegistry,
	blockCompatibilityRegistry,
	registerEmailClient,
	unregisterEmailClient,
	registerBlockCompatibility,
	unregisterBlockCompatibility,
	getAllEmailClients,
	getEmailClientInfo,
	mergeBlockCompatibility,
	lookupClientSupport,
} from './compatibility/index';
export type {
	SupportLevel,
	RenderEngine,
	DegradationImpact,
	EmailClientInfo,
	ClientSupport,
	CompatibilityFix,
	FeatureCompatibility,
	PropertyCompatibility,
	BlockCompatibilityScore,
} from './compatibility/index';
