/**
 * What the reader shows of a signed message, and whether its signature
 * verdict may stand beside it. The rules live in `@owlat/shared/signedScope`,
 * shared with the backend's interpretation scope so the two cannot drift; this
 * module is the reader's import path for them.
 */
import {
	isDetachedSignatureAttachment,
	resolveSignedBodyView,
	signedBodyScopeOf,
} from '@owlat/shared/signedScope';

export type {
	SignedBodyInput,
	SignedBodyScope,
	SignedBodyText,
	SignedBodyView,
} from '@owlat/shared/signedScope';

export { isDetachedSignatureAttachment, resolveSignedBodyView, signedBodyScopeOf };
