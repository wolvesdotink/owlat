/**
 * Makes parallel `ctx.storage.store` calls in one action safe under convex-test.
 *
 * convex-test's `storage/storeBlob` syscall asks whether a transaction is open
 * and, if not, opens its own; then, inside it, it awaits the blob's SHA-256
 * before inserting the `_storage` row. "Is a transaction open" is one global
 * flag. So with two stores in flight (`Promise.allSettled` over a message's
 * attachments, `mail/deliveryPipeline/deferredCapture.ts`) the second sees the
 * first's transaction, skips opening its own, and awaits its hash; when the
 * first commits before that hash is done, the second insert throws "Write
 * outside of transaction". How long a hash takes depends on the host's load,
 * so the suite failed now and then (`mailAttachmentCapture.integration.test.ts`,
 * "stages every eligible part of a multi-attachment message"). Production
 * Convex runs each store on its own; only the fake had the window.
 *
 * This plugin hashes the blob BEFORE the transaction check, so nothing is
 * awaited between the check and the insert, and the window is gone.
 *
 * If a convex-test upgrade changes the lines, the transform throws and every
 * test that loads convex-test fails, rather than the fix going quiet.
 */

const CONVEX_TEST_ENTRY = /[\\/]node_modules[\\/]convex-test[\\/]dist[\\/]index\.js(\?.*)?$/;

const STORE_LINES = [
	'const storageId = await writeToDatabase(async (db) => {',
	'                    return db.insert("_storage", {',
	'                        size: blob.size,',
	'                        sha256: await blobSha(blob),',
	'                    });',
	'                });',
].join('\n');

const STORE_HASHED_FIRST = [
	'const sha256 = await blobSha(blob);',
	'                const storageId = await writeToDatabase(async (db) => {',
	'                    return db.insert("_storage", { size: blob.size, sha256 });',
	'                });',
].join('\n');

/** Structurally a Vite plugin; typed locally so the api package needs no `vite` import. */
export interface StorageStoreSeamPlugin {
	name: string;
	enforce: 'pre';
	transform(code: string, id: string): string | null;
}

export function storageStoreSeam(): StorageStoreSeamPlugin {
	return {
		name: 'owlat:storage-store-seam',
		enforce: 'pre',
		transform(code, id) {
			if (!CONVEX_TEST_ENTRY.test(id)) return null;
			const occurrences = code.split(STORE_LINES).length - 1;
			if (occurrences !== 1) {
				throw new Error(
					`storageStoreSeam: expected one storage/storeBlob insert in ${id}, found ${occurrences}. ` +
						'convex-test changed; update convex/__tests__/helpers/storageStoreSeam.ts.'
				);
			}
			return code.replace(STORE_LINES, () => STORE_HASHED_FIRST);
		},
	};
}
