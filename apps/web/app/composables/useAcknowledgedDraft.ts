import { ref, type Ref } from 'vue';

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
 * account, another target); without it the settle goes through `text`.
 */
export function useAcknowledgedDraft(
	text: Ref<string>,
	pin: () => (update: (current: string) => string) => void = () => (update) => {
		text.value = update(text.value);
	}
) {
	const isSending = ref(false);

	async function submit(
		deliver: (snapshot: string) => Promise<{ ok: boolean }>
	): Promise<{ ok: boolean } | null> {
		if (isSending.value) return null;
		const snapshot = text.value;
		const settle = pin();
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
