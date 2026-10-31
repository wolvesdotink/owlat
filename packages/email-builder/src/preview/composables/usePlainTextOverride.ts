import { ref, computed, watch } from 'vue';
import { useBuilderI18n } from '../../i18n/useBuilderI18n';

/** The previewer props the Text view reads. */
interface PlainTextSources {
	/** Plain text generated from the block document, with preview variables filled. */
	plainText: string;
	/** The generated plain text without preview variable substitution. */
	plainTextSource: string;
	/** The author's manual text/plain body; empty string when none is stored. */
	plainTextOverride: string;
}

/**
 * The Text view's manual plain-text body: whether it is being edited, what the
 * view shows and what a recipient on a text-only client gets. Every change is
 * handed to `update`, which persists it as the stored override.
 */
export function usePlainTextOverride(props: PlainTextSources, update: (value: string) => void) {
	const { t } = useBuilderI18n();

	// Plain-text override. The stored override is the source of truth; the local
	// draft exists so typing does not wait on a round-trip through the host.
	const plainTextDraft = ref(props.plainTextOverride);
	watch(
		() => props.plainTextOverride,
		(v) => {
			if (v !== plainTextDraft.value) plainTextDraft.value = v;
		}
	);

	const isPlainTextOverridden = computed(() => props.plainTextOverride.trim().length > 0);

	// Whether the editor is open, tracked separately from "an override is stored":
	// clearing the textarea mid-edit must not yank the editor out from under the
	// cursor — it only means the generated body wins if the author leaves it empty.
	const isEditingPlainText = ref(isPlainTextOverridden.value);
	watch(isPlainTextOverridden, (overridden) => {
		// A template loading in with a stored override opens straight into the editor.
		if (overridden) isEditingPlainText.value = true;
	});

	/** The one-line explanation of what recipients on a text-only client will get. */
	const plainTextStatus = computed(() => {
		if (!isEditingPlainText.value) return t('builder.preview.plainText.generated');
		return isPlainTextOverridden.value
			? t('builder.preview.plainText.custom')
			: t('builder.preview.plainText.empty');
	});

	/** What the Text view shows: the author's body when set, else the generated one. */
	const displayPlainText = computed(() =>
		isPlainTextOverridden.value ? props.plainTextOverride : props.plainText
	);

	function startPlainTextOverride() {
		// Seed from the UNFILLED generated body so variable tokens survive editing.
		const seed = props.plainTextSource || props.plainText;
		isEditingPlainText.value = true;
		plainTextDraft.value = seed;
		update(seed);
	}

	function updatePlainTextOverride(value: string) {
		plainTextDraft.value = value;
		update(value);
	}

	function resetPlainTextOverride() {
		isEditingPlainText.value = false;
		plainTextDraft.value = '';
		update('');
	}

	return {
		plainTextDraft,
		isEditingPlainText,
		plainTextStatus,
		displayPlainText,
		startPlainTextOverride,
		updatePlainTextOverride,
		resetPlainTextOverride,
	};
}
