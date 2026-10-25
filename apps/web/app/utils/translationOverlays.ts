import type { TranslatableBlockContent } from '@owlat/api/translationMerge';
import { decodeJsonText, parserDecoder } from '@owlat/worker-protocol/decodeJson';
import { isRecord } from '@owlat/shared/utils/guards';

/**
 * One language's overlay as an email row stores it in `translations`: its
 * subject and preview text and, per Block id, the translated text fields. An
 * overlay added on the Settings page has no `blocks` yet. Fields this build
 * does not know are kept, so a newer release's additions survive a save.
 */
export interface StoredTranslationOverlay {
	subject?: string;
	previewText?: string;
	blocks?: Record<string, TranslatableBlockContent>;
	[field: string]: unknown;
}

const BLOCK_TEXT_FIELDS = ['html', 'buttonText', 'alt'] as const;

/** True when `value` is absent or a string. */
function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === 'string';
}

function isBlockText(value: unknown): value is TranslatableBlockContent {
	return isRecord(value) && BLOCK_TEXT_FIELDS.every((field) => isOptionalString(value[field]));
}

function isOverlay(value: unknown): value is StoredTranslationOverlay {
	if (!isRecord(value)) return false;
	if (!isOptionalString(value['subject']) || !isOptionalString(value['previewText'])) return false;
	const { blocks } = value;
	return blocks === undefined || (isRecord(blocks) && Object.values(blocks).every(isBlockText));
}

const overlaysDecoder = parserDecoder((value): Record<string, StoredTranslationOverlay> | null => {
	if (!isRecord(value)) return null;
	const overlays: Record<string, StoredTranslationOverlay> = {};
	for (const [language, overlay] of Object.entries(value)) {
		if (!isOverlay(overlay)) return null;
		overlays[language] = overlay;
	}
	return overlays;
}, '$: expected an object of translation overlays');

/**
 * A row's `translations` blob, keyed by language. An absent or empty blob is
 * no overlays. Anything else that is not JSON of overlays is `null`: a caller
 * must not build a write on it, because the write would replace text the row
 * still holds with what it could not read.
 */
export function readTranslationOverlays(
	blob: string | undefined
): Record<string, StoredTranslationOverlay> | null {
	if (!blob) return {};
	const decoded = decodeJsonText(blob, overlaysDecoder);
	return decoded.ok ? decoded.value : null;
}

/** {@link readTranslationOverlays} for a render that cannot go on without them. */
export function requireTranslationOverlays(
	blob: string | undefined
): Record<string, StoredTranslationOverlay> {
	const overlays = readTranslationOverlays(blob);
	if (!overlays) throw new Error('Could not read the translations stored on the email');
	return overlays;
}
