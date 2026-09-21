/**
 * usePostboxComposerGuards — the composer's deterministic confidence layer
 * (plan ideas 3, 4, 5, 6, 15).
 *
 * What is load-bearing here is not any single check (each has its own pure-unit
 * suite) but the CHOREOGRAPHY around them:
 *   • every gate warns, none of them blocks — `blockSend` always ends in a
 *     decision the sender can take, and confirming replays the exact send with
 *     its scheduled time intact;
 *   • each gate asks ONCE per composer, so a send that trips two of them walks
 *     through them one replay at a time instead of nagging forever;
 *   • the first-time cue stays silent until the mailbox has actually answered —
 *     a pending read is not evidence that someone is a stranger;
 *   • none of it needs the `ai` flag.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, type Ref } from 'vue';

import { createTestI18n } from '~/__tests__/i18n';
import type { AlignableIdentity } from '~/utils/senderAlignment';
import { usePostboxComposerGuards, type GuardSendOptions } from '../usePostboxComposerGuards';

vi.mock('@owlat/api', () => ({
	api: {
		mail: {
			contacts: {
				knownRecipients: 'contacts.knownRecipients',
				correspondentDomains: 'contacts.correspondentDomains',
			},
		},
	},
}));

let knownData: Ref<string[] | undefined>;
let domainData: Ref<string[] | undefined>;

const { t } = createTestI18n().global;

beforeEach(() => {
	knownData = ref<string[] | undefined>([]);
	domainData = ref<string[] | undefined>([]);
	vi.stubGlobal('useI18n', () => ({ t, locale: ref('en') }));
	vi.stubGlobal('useConvexQuery', (query: string) => ({
		data: query === 'contacts.knownRecipients' ? knownData : domainData,
	}));
});

const ALIGNED: AlignableIdentity = {
	address: 'ada@northwind.studio',
	domainVerified: true,
	alignment: 'aligned',
};
const MISALIGNED: AlignableIdentity = {
	address: 'ada@northwind.studio',
	domainVerified: true,
	alignment: 'misaligned',
	alignmentReason: 'This transport signs mail as another domain.',
};

interface DraftState {
	identities?: AlignableIdentity[];
	subject?: string;
	bodyHtml?: string;
	recipients?: string[];
	attachmentCount?: number;
}

function mountGuards(state: DraftState = {}) {
	const confirmed: (GuardSendOptions | undefined)[] = [];
	const guards = usePostboxComposerGuards(
		{
			mailboxId: () => 'mbx_1' as never,
			identities: () => state.identities ?? [ALIGNED],
			fromAddress: () => 'ada@northwind.studio',
			subject: () => state.subject ?? 'Q3 recap',
			bodyHtml: () => state.bodyHtml ?? '<p>Numbers below.</p>',
			recipients: () => state.recipients ?? ['ines@northwind.studio'],
			attachmentCount: () => state.attachmentCount ?? 0,
		},
		{ onConfirm: (opts) => void confirmed.push(opts) }
	);
	return { guards, confirmed };
}

describe('usePostboxComposerGuards — a clean draft', () => {
	it('lets the send through with nothing to say', () => {
		knownData.value = ['ines@northwind.studio'];
		const { guards, confirmed } = mountGuards();

		expect(guards.blockSend()).toBe(false);
		expect(guards.preflight).toEqual([]);
		expect(guards.alignmentWarning).toBeNull();
		expect(guards.attachmentHint).toBeNull();
		expect(confirmed).toEqual([]);
	});
});

describe('usePostboxComposerGuards — alignment (idea 3)', () => {
	it('parks a send from a misaligned identity and replays it on confirm', () => {
		knownData.value = ['ines@northwind.studio'];
		const { guards, confirmed } = mountGuards({ identities: [MISALIGNED] });

		expect(guards.blockSend({ scheduledSendAt: 4321 })).toBe(true);
		expect(guards.alignment.open).toBe(true);
		expect(confirmed).toEqual([]);

		guards.alignment.confirm();
		// The exact send comes back — a warning, not a block.
		expect(confirmed).toEqual([{ scheduledSendAt: 4321 }]);
		expect(guards.alignment.open).toBe(false);
	});

	it('asks once — the second attempt is not re-interrupted', () => {
		knownData.value = ['ines@northwind.studio'];
		const { guards } = mountGuards({ identities: [MISALIGNED] });

		guards.blockSend();
		guards.alignment.confirm();
		expect(guards.blockSend()).toBe(false);
	});

	it('says nothing about an identity that is merely unconfirmed', () => {
		knownData.value = ['ines@northwind.studio'];
		const { guards } = mountGuards({
			identities: [{ ...ALIGNED, alignment: 'unknown' }],
		});
		expect(guards.blockSend()).toBe(false);
	});
});

describe('usePostboxComposerGuards — attachment (idea 15)', () => {
	it('parks a draft that promises an attachment it does not carry', () => {
		knownData.value = ['ines@northwind.studio'];
		const { guards, confirmed } = mountGuards({ bodyHtml: '<p>Contract attached.</p>' });

		expect(guards.blockSend()).toBe(true);
		expect(guards.attachment.open).toBe(true);
		expect(guards.attachmentHint).toEqual({ kind: 'mention', phrase: 'attached' });

		guards.attachment.confirm();
		expect(confirmed).toEqual([undefined]);
	});

	it('is silent once the draft actually has an attachment', () => {
		knownData.value = ['ines@northwind.studio'];
		const { guards } = mountGuards({
			bodyHtml: '<p>Contract attached.</p>',
			attachmentCount: 1,
		});
		expect(guards.blockSend()).toBe(false);
	});
});

describe('usePostboxComposerGuards — first-time recipients (idea 5)', () => {
	it('names the strangers and replays the send when confirmed', () => {
		knownData.value = ['ines@northwind.studio'];
		const { guards, confirmed } = mountGuards({
			recipients: ['ines@northwind.studio', 'stranger@acme-corp.io'],
		});

		expect(guards.firstTimeAddresses).toEqual(['stranger@acme-corp.io']);
		expect(guards.blockSend()).toBe(true);
		guards.firstTime.confirm();
		expect(confirmed).toEqual([undefined]);
	});

	it('dismissing settles the cue without sending anything', () => {
		knownData.value = [];
		const { guards, confirmed } = mountGuards({ recipients: ['stranger@acme-corp.io'] });

		expect(guards.blockSend()).toBe(true);
		guards.firstTime.dismiss();
		expect(confirmed).toEqual([]);
		expect(guards.firstTime.open).toBe(false);
		// Settled: the sender read it, so the next attempt goes straight out.
		expect(guards.blockSend()).toBe(false);
	});

	it('stays silent while the mailbox has not answered', () => {
		knownData.value = undefined;
		const { guards } = mountGuards({ recipients: ['stranger@acme-corp.io'] });

		expect(guards.firstTimeAddresses).toEqual([]);
		expect(guards.blockSend()).toBe(false);
	});
});

describe('usePostboxComposerGuards — ordering and the advisory chip', () => {
	it('walks a draft that trips everything through one gate per replay', () => {
		knownData.value = [];
		const { guards } = mountGuards({
			identities: [MISALIGNED],
			subject: '',
			bodyHtml: '<p>Deck attached. [TODO] finish this</p>',
			recipients: ['stranger@acme-corp.io'],
		});

		expect(guards.blockSend()).toBe(true);
		expect(guards.alignment.open).toBe(true);
		guards.alignment.confirm();

		expect(guards.blockSend()).toBe(true);
		expect(guards.attachment.open).toBe(true);
		guards.attachment.confirm();

		expect(guards.blockSend()).toBe(true);
		expect(guards.firstTime.open).toBe(true);
		guards.firstTime.confirm();

		expect(guards.blockSend()).toBe(false);
	});

	it('never lets the advisory preflight interrupt a send', () => {
		knownData.value = ['ines@northwind.studio'];
		const { guards } = mountGuards({ subject: '', bodyHtml: '<p>[TODO] numbers</p>' });

		expect(guards.preflight.map((f) => f.id)).toEqual(['emptySubject', 'placeholder']);
		expect(guards.blockSend()).toBe(false);
	});

	it('exposes the correspondent domains the did-you-mean hint reads', () => {
		domainData.value = ['northwind.studio'];
		knownData.value = ['ines@northwind.studio'];
		const { guards } = mountGuards();
		expect(guards.knownDomains).toEqual(['northwind.studio']);
	});
});
