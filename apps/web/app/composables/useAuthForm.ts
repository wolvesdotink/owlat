/**
 * Submit lifecycle for the auth forms.
 *
 * login / register / reset-password each hand-rolled the same orchestration:
 * clear the error, flip a loading flag, run the action, map a thrown Error to a
 * user-facing message (falling back to a generic one), and always clear loading.
 * This owns that lifecycle so the pages keep only their own validation and
 * success path.
 *
 * Note: forgot-password deliberately does NOT use this — it swallows errors and
 * always reports success to avoid leaking whether an account exists, so its
 * catch branch is intentionally different.
 */
export function useAuthForm() {
	const isLoading = ref(false);
	const errorMessage = ref('');

	/**
	 * Run a submit action with the shared loading/error lifecycle. The action
	 * owns the success path (navigation or setting a success flag); a thrown
	 * Error's message is surfaced, otherwise `fallbackMessage`.
	 */
	const submit = async (
		action: () => Promise<void>,
		fallbackMessage = 'An unexpected error occurred. Please try again.',
	): Promise<void> => {
		errorMessage.value = '';
		isLoading.value = true;
		try {
			await action();
		} catch (error) {
			errorMessage.value = error instanceof Error ? error.message : fallbackMessage;
		} finally {
			isLoading.value = false;
		}
	};

	return { isLoading, errorMessage, submit };
}
