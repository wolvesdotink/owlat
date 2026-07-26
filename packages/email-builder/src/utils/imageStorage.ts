const IMAGE_STORAGE_KEY_BY_SOURCE = {
	src: 'storageId',
	darkSrc: 'darkStorageId',
} as const;

/**
 * Resolve the durable storage-identity property paired with an image source
 * property. Keeping this map in one place prevents primary and dark-mode image
 * updates from drifting apart.
 */
export function storageIdentityKeyForImageSource(sourceKey: string): string | undefined {
	return IMAGE_STORAGE_KEY_BY_SOURCE[sourceKey as keyof typeof IMAGE_STORAGE_KEY_BY_SOURCE];
}
