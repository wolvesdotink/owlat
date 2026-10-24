/**
 * Which way a send from the Postbox composer goes, and the keys that send it.
 *
 * A reply (the seed answers a message) takes the "after replying" setting: Send
 * and Cmd/Ctrl+Enter do what it says, Cmd/Ctrl+Alt+Enter does the opposite, and
 * the menu beside Send names both. The action is fixed when the send is asked
 * for and travels in the send's options, so a gate that parks the send (an
 * upload, the seal, the confidence checks, a stale reply) replays it unchanged
 * even if the setting moves meanwhile. A new message or a forward has no
 * conversation to finish: it carries no action and gets no menu.
 */

import type { Ref } from 'vue';
import type { ComposerSeed } from './usePostboxCompose';
import type { SendOpts } from './usePostboxComposeOfflineSend';
import {
	afterReplyFor,
	type ComposerSendActions,
	type PostboxAfterReply,
} from '~/utils/postboxAfterReply';

type ComposerSendOptions = Omit<SendOpts, 'undoSendDelayMs'>;

export function usePostboxComposerSendChoice(o: {
	seed: () => ComposerSeed;
	rootEl: Ref<HTMLElement | null>;
	canSend: Ref<boolean>;
	sending: Ref<boolean>;
	isScheduled: Ref<boolean>;
	scheduleOpen: Ref<boolean>;
	/** The guarded send (usePostboxComposerSendGate's `handleSend`). */
	send: (opts?: ComposerSendOptions) => unknown;
	onMinimize: () => void;
}) {
	const { afterReply } = usePostboxSettings();
	const isReply = computed(() => !!o.seed().inReplyToMessageId);

	/** The options one send takes: its after-reply action, for a reply only. */
	function actionOptions(choice?: PostboxAfterReply | 'opposite'): ComposerSendOptions {
		return isReply.value ? { afterSend: afterReplyFor(afterReply.value, choice) } : {};
	}

	const { sendShortcutHint, scheduleShortcutHint, sendChords, onComposerKeydown } =
		usePostboxComposerKeys({
			rootEl: o.rootEl,
			canSend: o.canSend,
			sending: o.sending,
			isScheduled: o.isScheduled,
			scheduleOpen: o.scheduleOpen,
			onSend: () => void o.send(actionOptions()),
			onSendAlternate: () => void o.send(actionOptions('opposite')),
			onSchedule: () => {
				o.scheduleOpen.value = true;
			},
			onMinimize: o.onMinimize,
		});

	/** The Send menu, for a reply: what Send does, and the chord for each action. */
	const sendActions = computed<ComposerSendActions | undefined>(() => {
		if (!isReply.value) return undefined;
		const primary = afterReply.value;
		const c = sendChords.value;
		// Send's own chord takes the setting's action; the alternate one the other.
		const own = (action: PostboxAfterReply) => action === primary;
		return {
			primary,
			chords: {
				keep: own('keep') ? c.send : c.alternate,
				done: own('done') ? c.send : c.alternate,
			},
			aria: {
				keep: own('keep') ? c.sendAria : c.alternateAria,
				done: own('done') ? c.sendAria : c.alternateAria,
			},
		};
	});

	return {
		onComposerKeydown,
		/** The footer's Send props: the hints and, for a reply, the Send menu. */
		footerSend: computed(() => ({
			sendShortcutHint: sendShortcutHint.value,
			scheduleShortcutHint: scheduleShortcutHint.value,
			sendActions: sendActions.value,
		})),
		/** Send, or (from the Send menu) send with an explicit action. */
		sendWith: (choice?: PostboxAfterReply) => o.send(actionOptions(choice)),
		/** The schedule dialog's confirm: a scheduled reply takes the setting's action. */
		scheduleAt: (scheduledSendAt: number) => o.send({ scheduledSendAt, ...actionOptions() }),
	};
}
