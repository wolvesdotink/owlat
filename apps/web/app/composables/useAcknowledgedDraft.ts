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
 */
export function useAcknowledgedDraft(text: Ref<string>) {
	const isSending = ref(false);

	async function submit(
		deliver: (snapshot: string) => Promise<{ ok: boolean }>
	): Promise<{ ok: boolean } | null> {
		if (isSending.value) return null;
		const snapshot = text.value;
		isSending.value = true;
		let outcome: { ok: boolean };
		try {
			outcome = await deliver(snapshot);
		} finally {
			isSending.value = false;
		}
		if (outcome.ok && text.value.startsWith(snapshot)) {
			text.value = text.value.slice(snapshot.length);
		}
		return outcome;
	}

	return { isSending, submit };
}
