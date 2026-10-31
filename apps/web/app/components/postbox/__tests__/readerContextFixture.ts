/**
 * A typed reader context for tests that mount PostboxReaderMessage without a
 * reader around it: `global: { provide: readerContextProvide({ reduced: true }) }`.
 */
import {
	POSTBOX_READER_CTX,
	type PostboxReaderContext,
} from '~/composables/postbox/usePostboxReaderContext';

export function readerContext(over: Partial<PostboxReaderContext> = {}): PostboxReaderContext {
	return {
		mailboxId: 'mbx_1',
		authEnabled: false,
		sealedEnabled: false,
		appIsDark: false,
		ownEmail: undefined,
		downloadingAttachment: null,
		eagerBody: false,
		reduced: false,
		chromeOf: () => ({ detailsTo: null, imageBannerTo: null, hideDanger: false }),
		quoteReply: null,
		findOf: () => null,
		findCountOf: () => 0,
		...over,
	};
}

export function readerContextProvide(over: Partial<PostboxReaderContext> = {}) {
	return { [POSTBOX_READER_CTX as symbol]: readerContext(over) };
}
