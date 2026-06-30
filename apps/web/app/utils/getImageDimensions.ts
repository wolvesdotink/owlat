/**
 * Read image dimensions client-side using the browser Image API.
 * Returns null for SVGs (they may not have intrinsic dimensions).
 */
export function getImageDimensions(
	file: File
): Promise<{ width: number; height: number } | null> {
	if (file.type === 'image/svg+xml') return Promise.resolve(null);

	return new Promise((resolve) => {
		const url = URL.createObjectURL(file);
		const img = new Image();
		img.onload = () => {
			resolve({ width: img.naturalWidth, height: img.naturalHeight });
			URL.revokeObjectURL(url);
		};
		img.onerror = () => {
			resolve(null);
			URL.revokeObjectURL(url);
		};
		img.src = url;
	});
}
