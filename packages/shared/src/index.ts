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
export { type OutboundTlsMode, OUTBOUND_TLS_MODES, isOutboundTlsMode } from './outboundTlsMode';
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
