/**
 * The storage seam (helpers/storageStoreSeam.ts): one action storing blobs in
 * parallel gets every store, whichever hash finishes first. Without the seam,
 * the small blob's transaction commits while the large blob is still hashing,
 * and the large store throws "Write outside of transaction" every time.
 */

import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import { expect, it } from 'vitest';
import { internalAction } from '../_generated/server';
import schema from '../schema';

const modules = {
	...import.meta.glob('../_generated/*.*s'),
	'../storageSeamProbe.ts': async () => ({
		storeInParallel: internalAction({
			args: {},
			handler: async (ctx) => {
				const small = new Blob([new Uint8Array(10)]);
				const large = new Blob([new Uint8Array(20_000_000)]);
				const settled = await Promise.allSettled([
					ctx.storage.store(small),
					ctx.storage.store(large),
				]);
				return settled.map((r) => r.status);
			},
		}),
	}),
};

it('lands every blob of a parallel store', async () => {
	const t = convexTest(schema, modules);
	const statuses = await t.action(
		makeFunctionReference<'action'>('storageSeamProbe:storeInParallel') as never,
		{}
	);
	expect(statuses).toEqual(['fulfilled', 'fulfilled']);
	expect(await t.run((ctx) => ctx.db.system.query('_storage').collect())).toHaveLength(2);
});
