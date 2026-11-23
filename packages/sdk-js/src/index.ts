// Main client export
export { Owlat } from './client';

// Type exports
export type {
	// Config
	OwlatConfig,
	// Common
	PaginationParams,
	PaginationMeta,
	RateLimitInfo,
	ApiResponse,
	PaginatedResponse,
	RequestOptions,
	JsonPrimitive,
	// Errors
	ApiErrorReason,
	ApiKeyErrorReason,
	TransactionalRefusalReason,
	// Contacts
	Contact,
	ContactSource,
	CreateContactParams,
	UpdateContactParams,
	DeleteContactResponse,
	// Transactional
	SendTransactionalParams,
	SendTransactionalResponse,
	TransactionalAttachment,
	TransactionalSendStatus,
	TransactionalSendStatusValue,
	// Events
	SendEventParams,
	SendEventResponse,
	// Topics
	DoiStatus,
	AddToTopicParams,
	RemoveFromTopicParams,
	AddToTopicResponse,
	RemoveFromTopicResponse,
} from './types';

// Error exports
export {
	OwlatError,
	AuthenticationError,
	RateLimitError,
	NotFoundError,
	ValidationError,
	ConflictError,
	ForbiddenError,
	InvalidStateError,
	LimitReachedError,
	UnexpectedResponseError,
} from './errors';
