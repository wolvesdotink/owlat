import { postboxImagesLoadOnOpen, type PostboxBodyImageProps } from '~/utils/postboxImageAllowlist';

/**
 * Per-message consent to load a body's remote images, split out of
 * PostboxMessageBody (which owns the render pipeline and sits at the file-size
 * ceiling).
 *
 * `showImages` starts false; the load-on-open policy (preference, allowlist,
 * suspicious mail; see utils/postboxImageAllowlist) flips it before first
 * paint, so there is no click and no flash of the banner. Watching rather than
 * initialising once matters twice over: the settings and allowlist queries
 * resolve after first render, and the reader reuses the body across messages,
 * so a revoke in settings — or moving to a suspicious message — must take the
 * images back.
 */
export function usePostboxImageConsent(source: {
	messageId: () => string | undefined;
	images: () => Partial<PostboxBodyImageProps>;
}) {
	const showImages = ref(false);
	// Escalation past "Show images": also load probable tracking pixels, which
	// otherwise stay stripped even after images are shown. Deliberately NOT
	// implied by the preference or the allowlist, and never persisted.
	const loadEverything = ref(false);

	watch(
		[() => postboxImagesLoadOnOpen(source.images()), source.messageId],
		([load]) => {
			showImages.value = load;
			if (!load) loadEverything.value = false;
		},
		{ immediate: true }
	);

	/**
	 * "Load everything" from any banner. From the `unchecked` banner images may
	 * not be shown yet, and the escalation has to include them.
	 */
	function loadEverythingNow() {
		showImages.value = true;
		loadEverything.value = true;
	}

	return { showImages, loadEverything, loadEverythingNow };
}
