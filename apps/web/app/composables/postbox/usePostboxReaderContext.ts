/**
 * What every message card of one reader shares: the reader's mailbox, the
 * feature flags, the theme, the reader-wide modes and where each card's
 * chrome renders. The host (PostboxThreadReader, Answer mode's conversation)
 * provides it once; PostboxReaderMessage reads it, so its props carry only
 * what differs between messages.
 *
 * Values are read through getters on every access, so a host that switches
 * mailbox, flags, theme or teleport targets without remounting re-renders
 * its cards. `provide` scopes it to the host's subtree: two readers mounted
 * side by side never see each other's context.
 */
import { inject, provide, toValue, type InjectionKey, type MaybeRefOrGetter } from 'vue';

/** Where one card's chrome renders; null renders it in the card itself. */
export interface PostboxReaderCardChrome {
	/** The calm reader's Details panel: the card's chips teleport there. */
	detailsTo: HTMLElement | null;
	/** Where the image banner renders instead of above the body. */
	imageBannerTo: HTMLElement | null;
	/** The thread's notice slot says the danger; the card does not repeat it. */
	hideDanger: boolean;
}

export interface PostboxReaderContext {
	/** The reader's mailbox: the thread's, not necessarily each message's. */
	readonly mailboxId: string;
	/** Feature flag `senderAuthBadges`. */
	readonly authEnabled: boolean;
	/** Feature flag `sealedMail`. */
	readonly sealedEnabled: boolean;
	/** The app is in dark mode, so the per-message light-render escape hatch applies. */
	readonly appIsDark: boolean;
	/** The mailbox's own address (the invite card answers as it). */
	readonly ownEmail: string | undefined;
	/** `${messageId}:${part}` of the attachment currently being fetched, if any. */
	readonly downloadingAttachment: string | null;
	/** Mount every body now instead of when it nears the viewport (printing). */
	readonly eagerBody: boolean;
	/**
	 * Answer mode's cut of every card: no action row, the trust chip only when
	 * the sender is not verified, and To/Cc, the unsubscribe chip and the
	 * message details behind a click on the sender name.
	 */
	readonly reduced: boolean;
	/** The card's chrome placement; the calm reader owns that policy. */
	chromeOf(messageId: string): PostboxReaderCardChrome;
}

type ContextValues = Omit<PostboxReaderContext, 'chromeOf'>;

export type PostboxReaderContextSource = {
	[K in keyof ContextValues]: MaybeRefOrGetter<ContextValues[K]>;
} & {
	/** Omitted: every card renders its chrome in place. */
	chromeOf?: (messageId: string) => PostboxReaderCardChrome;
};

export const POSTBOX_READER_CTX: InjectionKey<PostboxReaderContext> =
	Symbol('postbox-reader-context');

const IN_PLACE: PostboxReaderCardChrome = Object.freeze({
	detailsTo: null,
	imageBannerTo: null,
	hideDanger: false,
});

/** Every read goes through the source, so the card tracks the host's state. */
function readThrough(source: PostboxReaderContextSource): PostboxReaderContext {
	const chromeOf = source.chromeOf;
	return {
		get mailboxId() {
			return toValue(source.mailboxId);
		},
		get authEnabled() {
			return toValue(source.authEnabled);
		},
		get sealedEnabled() {
			return toValue(source.sealedEnabled);
		},
		get appIsDark() {
			return toValue(source.appIsDark);
		},
		get ownEmail() {
			return toValue(source.ownEmail);
		},
		get downloadingAttachment() {
			return toValue(source.downloadingAttachment);
		},
		get eagerBody() {
			return toValue(source.eagerBody);
		},
		get reduced() {
			return toValue(source.reduced);
		},
		chromeOf: chromeOf ? (messageId) => chromeOf(messageId) : () => IN_PLACE,
	};
}

/** Provide the context to this host's cards; call from the host's setup. */
export function providePostboxReaderContext(
	source: PostboxReaderContextSource
): PostboxReaderContext {
	const context = readThrough(source);
	provide(POSTBOX_READER_CTX, context);
	return context;
}

/** The context of the reader this card renders in. */
export function usePostboxReaderContext(): PostboxReaderContext {
	const context = inject(POSTBOX_READER_CTX, null);
	// A card outside a reader would render without its mailbox and flags.
	if (!context) throw new Error('PostboxReaderMessage needs a reader context provider');
	return context;
}
