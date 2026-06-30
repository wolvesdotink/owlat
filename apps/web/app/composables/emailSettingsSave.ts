/**
 * Email-settings save — the app-side helper behind the marketing template
 * Settings page (pages/dashboard/emails/[id]/settings.vue). It routes the save
 * to the right backend mutation depending on whether the user changed the
 * template's **default language**.
 *
 * A plain field edit (subject/preview/supported-languages/overlay text) goes
 * through `api.emailTemplates.emails.update`, which just patches the row.
 *
 * Changing the default language is NOT a field patch: the body, subject, and
 * preview must be re-keyed so the newly-chosen language becomes the main
 * content and the outgoing default is demoted to a translation overlay. That is
 * exactly what `api.emailTemplates.i18n.setDefaultLanguage` does. Patching
 * `defaultLanguage` directly (the previous behaviour) relabelled the row's
 * language while leaving the old-language body in place — the content and its
 * declared language silently diverged. `setDefaultLanguage` only accepts a
 * target language that already has a translation overlay, so this helper refuses
 * the swap (rather than corrupt state) when the chosen default has none.
 */

export interface EmailSettingsUpdatePayload {
	subject: string;
	previewText: string | undefined;
	defaultLanguage: string;
	supportedLanguages: string[];
	translations: string;
}

export interface EmailSettingsSaveArgs {
	/** The default language currently persisted on the row (pre-edit). */
	persistedDefaultLanguage: string;
	/** The default language selected in the form (may equal the persisted one). */
	selectedDefaultLanguage: string;
	/**
	 * The languages whose translation overlay is present in the form's
	 * `updatePayload.translations` (i.e. that this save will persist). The default
	 * language can only be promoted to one of these — `setDefaultLanguage` needs
	 * the target's overlay on the row to merge into the body. Because the swap is
	 * now preceded by a persisting `update`, a just-added (not-yet-saved) overlay
	 * is a valid promotion target as long as it is in this list.
	 */
	overlayLanguages: string[];
	/** The full `update` payload for a plain (non-language-swap) save. */
	updatePayload: EmailSettingsUpdatePayload;
	/** Patch the row's editable fields (no content re-keying). */
	update: (payload: EmailSettingsUpdatePayload) => Promise<unknown>;
	/**
	 * Promote a translation overlay to the default language: merge its text into
	 * the body, demote the old default to an overlay, swap subject/preview.
	 */
	setDefaultLanguage: (payload: { language: string }) => Promise<unknown>;
}

export type EmailSettingsSaveResult =
	| { status: 'saved' }
	| { status: 'language-promoted' }
	| { status: 'no-overlay'; language: string }
	| { status: 'failed' };

/**
 * Decide which mutation(s) a settings save needs and run them.
 *
 * `update`/`setDefaultLanguage` are expected to swallow their own errors and
 * resolve to `undefined` on failure (the `useBackendOperation` contract); this
 * helper reports `failed` so the caller can keep the unsaved-changes flag set.
 *
 * Default-language change is a two-step save, not a single swap:
 *
 *   1. `update` persists the form's pending field edits (subject/preview/
 *      supported-languages/overlay text, including a just-added overlay) WITHOUT
 *      re-labelling the row — `defaultLanguage` is held at the persisted value.
 *      This makes the target overlay exist on the row (so the backend swap won't
 *      throw not-found) and stops concurrent edits from being silently dropped.
 *   2. `setDefaultLanguage` then re-keys subject/preview/content and demotes the
 *      old default to an overlay, reading the just-persisted state.
 *
 * The previous behaviour routed the swap as the SOLE write, which (a) discarded
 * any field edits made in the same save and (b) threw not-found when the target
 * overlay had only just been added in the form and never persisted.
 */
export async function emailSettingsSave(
	args: EmailSettingsSaveArgs,
): Promise<EmailSettingsSaveResult> {
	const languageChanged = args.selectedDefaultLanguage !== args.persistedDefaultLanguage;

	if (!languageChanged) {
		const result = await args.update(args.updatePayload);
		return result === undefined ? { status: 'failed' } : { status: 'saved' };
	}

	// Promoting to a language with no overlay would throw in the backend (and
	// has nothing to merge into the body), so refuse it up front with a clear
	// signal rather than attempting a corrupting swap.
	if (!args.overlayLanguages.includes(args.selectedDefaultLanguage)) {
		return { status: 'no-overlay', language: args.selectedDefaultLanguage };
	}

	// Step 1 — persist pending field edits / a just-added overlay first, but keep
	// the row's `defaultLanguage` at the persisted value so the upcoming swap
	// reads the correct outgoing-default content (the swap, not this patch, does
	// the re-keying). If this fails, abort before swapping.
	const updateResult = await args.update({
		...args.updatePayload,
		defaultLanguage: args.persistedDefaultLanguage,
	});
	if (updateResult === undefined) {
		return { status: 'failed' };
	}

	// Step 2 — promote the now-persisted overlay to the default language.
	const result = await args.setDefaultLanguage({ language: args.selectedDefaultLanguage });
	return result === undefined ? { status: 'failed' } : { status: 'language-promoted' };
}
