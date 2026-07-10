import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, nextTick, type Ref } from 'vue';

/**
 * Regression: reopening a saved draft must not have its body overwritten by the
 * default signature.
 *
 * The composer runs two async subscriptions against an initially-empty body:
 *   - drafts.get hydrates the saved body (guarded on `!bodyHtml.value`), and
 *   - signatures.list auto-prepends the default signature (also guarded on an
 *     empty body).
 * If signatures.list resolves FIRST it writes the signature into the empty body;
 * hydration's guard is then false so the saved body never loads; the deep
 * watcher fires autosave and ~1.5s later persists the signature OVER the saved
 * draft — permanent, silent data loss.
 *
 * The fix suppresses the signature auto-prepend when the composer was opened for
 * an existing draft (seed.draftId set) — a reopened draft already carries its
 * own signature in the saved body. A fresh compose still gets the signature.
 *
 * This test forces the losing interleaving (signatures BEFORE hydrate) and
 * asserts the saved body survives.
 */

// Mark the generated api functions with stable strings so the mocked
// useConvexQuery can tell the three subscriptions apart.
vi.mock('@owlat/api', () => ({
	api: {
		mail: {
			drafts: {
				get: 'drafts.get',
				create: 'drafts.create',
				update: 'drafts.update',
				setIdentity: 'drafts.setIdentity',
				discard: 'drafts.discard',
				send: 'drafts.send',
				cancelPendingSend: 'drafts.cancelPendingSend',
				cancelScheduledSend: 'drafts.cancelScheduledSend',
			},
			identities: {
				listForOwnedMailbox: 'identities.list',
				listSendAsIdentities: 'identities.listSendAs',
			},
			signatures: { list: 'signatures.list' },
		},
	},
}));

// The attachments sibling pulls its own Convex context; stub it out.
vi.mock('../usePostboxComposeAttachments', () => ({
	usePostboxComposeAttachments: () => ({
		attachments: ref([]),
		uploads: ref([]),
		isUploading: ref(false),
		attachmentSizeMeter: ref(null),
		thumbUrlFor: () => '',
		addFiles: () => {},
		removeAttachment: () => {},
		cancelUpload: () => {},
		retryUpload: () => {},
		addInlineImage: () => {},
		removeInlineImage: () => {},
	}),
}));

// Controllable subscription data, reset per test.
let hydrateData: Ref<unknown>;
let signaturesData: Ref<unknown>;
let identitiesData: Ref<unknown>;

beforeEach(() => {
	hydrateData = ref(undefined);
	signaturesData = ref(undefined);
	identitiesData = ref([]);

	vi.stubGlobal('useConvexQuery', (fn: unknown) => {
		if (fn === 'drafts.get') return { data: hydrateData };
		if (fn === 'signatures.list') return { data: signaturesData };
		if (fn === 'identities.list') return { data: identitiesData };
		return { data: ref(undefined) };
	});
	// Autosave/create/etc. are irrelevant here — never resolve to anything.
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(async () => undefined) }));
});

const DEFAULT_SIGNATURE = {
	_id: 'sig-1',
	name: 'Default',
	html: '<p>Regards, Alice</p>',
	isDefault: true,
};

async function loadComposable() {
	const mod = await import('../usePostboxCompose');
	return mod.usePostboxCompose;
}

describe('usePostboxCompose — reopened-draft signature race', () => {
	it('keeps the saved body when signatures resolve before the draft hydrates', async () => {
		const usePostboxCompose = await loadComposable();
		const composer = usePostboxCompose({
			mailboxId: 'mbx-1' as never,
			draftId: 'draft-42' as never,
		});

		// signatures.list wins the race first — the losing interleaving.
		signaturesData.value = [DEFAULT_SIGNATURE];
		await nextTick();

		// then the saved draft hydrates.
		hydrateData.value = { bodyHtml: '<p>SAVED DRAFT BODY</p>', state: 'draft' };
		await nextTick();

		expect(composer.bodyHtml.value).toContain('SAVED DRAFT BODY');
		expect(composer.bodyHtml.value).not.toContain('Regards, Alice');
		expect(composer.bodyHtml.value).not.toContain('data-postbox-signature');
	});

	it('still auto-prepends the default signature for a fresh compose', async () => {
		const usePostboxCompose = await loadComposable();
		const composer = usePostboxCompose({ mailboxId: 'mbx-1' as never });

		signaturesData.value = [DEFAULT_SIGNATURE];
		await nextTick();

		expect(composer.bodyHtml.value).toContain('Regards, Alice');
		expect(composer.bodyHtml.value).toContain('data-postbox-signature');
		expect(composer.activeSignatureId.value).toBe('sig-1');
	});
});
