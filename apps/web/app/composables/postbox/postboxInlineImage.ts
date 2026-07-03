/**
 * Client-side downscaling for images embedded inline into the Simple composer.
 *
 * A pasted/dropped photo is often multi-megapixel; shipping it verbatim inflates
 * the message and trips the attachment size guard. Before upload we downscale to
 * a sane max edge and re-encode (JPEG for opaque photos; PNG kept as PNG so
 * transparency and screenshots survive), all in the browser via a canvas.
 *
 * The dimension math is a pure function (`computeDownscaleDimensions`) so it can
 * be unit-tested without a DOM; `downscaleImageFile` is the canvas wrapper that
 * degrades to the original file whenever the browser image/canvas path is
 * unavailable or fails (advisory optimization, never a hard dependency).
 */

/** Longest-edge ceiling; a photo wider/taller than this is scaled down to fit. */
export const MAX_INLINE_IMAGE_EDGE = 1600;
/** JPEG quality for re-encoded opaque images. */
export const INLINE_IMAGE_JPEG_QUALITY = 0.85;

export interface DownscaleDimensions {
	width: number;
	height: number;
	/** True when the source exceeded the max edge and was scaled down. */
	scaled: boolean;
}

/**
 * Fit `(width, height)` within a `maxEdge`-by-`maxEdge` box, preserving aspect
 * ratio. An image already within the box is returned unchanged (`scaled:false`),
 * so callers can skip re-encoding a small image. Rounds to whole pixels.
 */
export function computeDownscaleDimensions(
	width: number,
	height: number,
	maxEdge: number = MAX_INLINE_IMAGE_EDGE,
): DownscaleDimensions {
	if (
		!Number.isFinite(width) ||
		!Number.isFinite(height) ||
		width <= 0 ||
		height <= 0
	) {
		return { width: 0, height: 0, scaled: false };
	}
	const longest = Math.max(width, height);
	if (longest <= maxEdge) {
		return { width: Math.round(width), height: Math.round(height), scaled: false };
	}
	const ratio = maxEdge / longest;
	return {
		width: Math.max(1, Math.round(width * ratio)),
		height: Math.max(1, Math.round(height * ratio)),
		scaled: true,
	};
}

/** Whether re-encoding must preserve transparency (keep PNG rather than JPEG). */
export function keepsPngFormat(mimeType: string): boolean {
	return /^image\/png$/i.test(mimeType);
}

/**
 * Downscale an image `File` to at most `MAX_INLINE_IMAGE_EDGE` on its longest
 * edge and re-encode it. Returns the original file untouched when the image is
 * already small, when it isn't a raster image, or when the browser canvas path
 * is unavailable / fails — inline embedding must never hard-fail on this.
 */
export async function downscaleImageFile(
	file: File,
	maxEdge: number = MAX_INLINE_IMAGE_EDGE,
): Promise<File> {
	if (!file.type.startsWith('image/') || /svg/i.test(file.type)) return file;
	if (typeof document === 'undefined' || typeof createImageBitmap === 'undefined') {
		return file;
	}
	try {
		const bitmap = await createImageBitmap(file);
		const dims = computeDownscaleDimensions(bitmap.width, bitmap.height, maxEdge);
		if (!dims.scaled) {
			bitmap.close?.();
			return file;
		}
		const canvas = document.createElement('canvas');
		canvas.width = dims.width;
		canvas.height = dims.height;
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			bitmap.close?.();
			return file;
		}
		ctx.drawImage(bitmap, 0, 0, dims.width, dims.height);
		bitmap.close?.();

		const keepPng = keepsPngFormat(file.type);
		const outType = keepPng ? 'image/png' : 'image/jpeg';
		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, outType, keepPng ? undefined : INLINE_IMAGE_JPEG_QUALITY),
		);
		if (!blob) return file;

		const ext = keepPng ? 'png' : 'jpg';
		const baseName = file.name.replace(/\.[^.]+$/, '') || 'image';
		return new File([blob], `${baseName}.${ext}`, { type: outType });
	} catch {
		// Any decode/encode failure: ship the original bytes.
		return file;
	}
}
