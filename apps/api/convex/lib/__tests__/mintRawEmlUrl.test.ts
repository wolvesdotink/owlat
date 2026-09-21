/**
 * `lib/sealedBlob.mintRawEmlUrl` — the raw-`.eml` URL both readers mint.
 *
 * The team-inbox action and the Postbox action used to carry the same three
 * lines each, and the "could not mint a URL" warn was added to one of them: on
 * the exact configuration state that warn exists for, the other download failed
 * in silence while the client told the user to try again. One helper, one log
 * line, and this file is what says the log line is there at all — `sealedBlobUrl`
 * returns its nulls silently by design, so nothing else would notice its loss.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, afterEach, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { mintRawEmlUrl, storeSealedBlob, SEALED_BLOB_PATH } from '../sealedBlob';
import * as runtimeLog from '../runtimeLog';

const modules = import.meta.glob('../../**/*.*s');

const SAVED_ENV = { ...process.env };

afterEach(() => {
	process.env = { ...SAVED_ENV };
	vi.restoreAllMocks();
});

async function seedRaw(t: ReturnType<typeof convexTest>): Promise<Id<'_storage'>> {
	return await t.run((ctx) =>
		storeSealedBlob(ctx.storage, new TextEncoder().encode('From: a@b\r\n\r\nhi'), 'message/rfc822')
	);
}

describe('mintRawEmlUrl', () => {
	it('mints a proxy URL when the instance is configured for one', async () => {
		const t = convexTest(schema, modules);
		process.env['INSTANCE_SECRET'] = 'a'.repeat(64);
		process.env['CONVEX_SITE_URL'] = 'https://site.test';
		const warn = vi.spyOn(runtimeLog, 'logWarn').mockImplementation(() => {});
		const storageId = await seedRaw(t);

		const url = await t.run((ctx) =>
			mintRawEmlUrl(ctx.storage, storageId, { logTag: '[Test]', messageId: 'm1' })
		);

		expect(url).toContain(SEALED_BLOB_PATH);
		// The content type is the one both readers serve, and it is bound into
		// the capability token — so it is not the caller's to get wrong.
		expect(url).toContain(`ct=${encodeURIComponent('message/rfc822')}`);
		expect(warn).not.toHaveBeenCalled();
	});

	it('says which configuration gap left it with no URL to hand back', async () => {
		const t = convexTest(schema, modules);
		// A key to seal with and nowhere to proxy through: every raw download on
		// every message fails, forever, and the client's only copy for a null is
		// "that attachment could not be downloaded".
		process.env['INSTANCE_SECRET'] = 'a'.repeat(64);
		delete process.env['CONVEX_SITE_URL'];
		const warn = vi.spyOn(runtimeLog, 'logWarn').mockImplementation(() => {});
		const storageId = await seedRaw(t);

		const url = await t.run((ctx) =>
			mintRawEmlUrl(ctx.storage, storageId, { logTag: '[Postbox raw]', messageId: 'm2' })
		);

		expect(url).toBeNull();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('[Postbox raw]'),
			expect.objectContaining({ messageId: 'm2' })
		);
	});
});
