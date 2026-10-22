import { ref, type Ref } from 'vue';

type PinTextSettle = () => (update: (current: string) => string) => void;

/**
 * Send a composer's draft without losing it to a failed send.
 *
 * `submit` freezes the text being sent and hands it to `deliver`. The draft
 * stays on screen, and editable, until `deliver` resolves `ok`; then only that
 * snapshot is taken away. Text typed after pressing Send follows the sent text,
 * so the sent prefix goes and the rest stays. A draft edited inside the sent
 * part no longer starts with it and is left alone: it is not what was sent.
 *
 * While a send is in flight `isSending` is true and a second `submit` returns
 * `null` without calling `deliver`, so a double Enter cannot send twice.
 *
 * `pin` (optional) binds the settle to the draft the send started from, for a
 * text that is a view over a draft that can change underneath it (another
 * account, another target); without it the settle goes through `text`. A
 * draft with more than text (files) passes its own pin to `submit`, so the
 * text and the rest are acknowledged in one update of the stored draft.
 */
export function useAcknowledgedDraft(
	text: Ref<string>,
	pin: PinTextSettle = () => (update) => {
		text.value = update(text.value);
	}
) {
	const isSending = ref(false);

	async function submit(
		deliver: (snapshot: string) => Promise<{ ok: boolean }>,
		pinSend: PinTextSettle = pin
	): Promise<{ ok: boolean } | null> {
		if (isSending.value) return null;
		const snapshot = text.value;
		const settle = pinSend();
		isSending.value = true;
		let outcome: { ok: boolean };
		try {
			outcome = await deliver(snapshot);
		} finally {
			isSending.value = false;
		}
		if (outcome.ok) {
			settle((current) =>
				current.startsWith(snapshot) ? current.slice(snapshot.length) : current
			);
		}
		return outcome;
	}

	return { isSending, submit };
}
