// @vitest-environment happy-dom
/**
 * The composer's From-picker grouping AND its live authenticity surface:
 *   - a single mailbox with only aliases (no personal send-as) renders FLAT
 *     options — group headings would just be noise;
 *   - a shared inbox that also offers the teammate's personal identity renders
 *     one <optgroup> per mailbox, labelled by the mailbox, with the TEAM group
 *     first (server order is preserved);
 *   - a broken identity (unverified domain or a misaligned transport) is
 *     DISABLED in the picker and surfaces the SenderAuthChip's plain-language
 *     reason (the disable-with-reason surface the campaign wizard also renders);
 *   - a clean (verified + aligned) selection stays quiet — no chip.
 *
 * The recipient fields are stubbed — only the From <select> + chip are under test.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import type { Id } from '@owlat/api/dataModel';
import type { SendAsIdentity } from '~/composables/postbox/usePostboxCompose';
import PostboxComposerEnvelope from '../PostboxComposerEnvelope.vue';
// The composer auto-imports this as <CampaignsSenderAuthChip>; register the real
// component (not a stub) so the disable-with-reason copy is asserted end-to-end.
import CampaignsSenderAuthChip from '../../campaigns/SenderAuthChip.vue';

function mb(id: string): Id<'mailboxes'> {
	return id as Id<'mailboxes'>;
}

// A verified, aligned identity by default; override per test to exercise the
// authenticity annotation the composer picker now renders.
function identity(over: Partial<SendAsIdentity> & Pick<SendAsIdentity, 'address'>): SendAsIdentity {
	return {
		mailboxId: mb('mb-team'),
		kind: 'own',
		label: 'Team',
		domainVerified: true,
		alignment: 'aligned',
		alignmentReason: null,
		...over,
	};
}

const mountOpts = {
	global: {
		components: { CampaignsSenderAuthChip },
		stubs: {
			Icon: true,
			PostboxRecipientField: true,
		},
	},
};

const baseProps = {
	mailboxId: mb('mb-team'),
	fromAddress: '',
	toAddresses: [],
	ccAddresses: [],
	bccAddresses: [],
	subject: '',
};

describe('PostboxComposerEnvelope — From picker grouping', () => {
	it('aliases-only renders flat options (no optgroups)', () => {
		const availableIdentities: SendAsIdentity[] = [
			identity({ address: 'team@hinterland.camp', kind: 'own', label: 'Team' }),
			identity({ address: 'hello@hinterland.camp', kind: 'own', label: 'Team' }),
		];
		const wrapper = mount(PostboxComposerEnvelope, {
			...mountOpts,
			props: { ...baseProps, availableIdentities },
		});
		// The picker shows (more than one identity) but as a flat list.
		expect(wrapper.find('[data-testid="postbox-from-select"]').exists()).toBe(true);
		expect(wrapper.findAll('optgroup')).toHaveLength(0);
		const options = wrapper.findAll('option');
		expect(options).toHaveLength(2);
		expect(options.map((o) => o.attributes('value'))).toEqual([
			'team@hinterland.camp',
			'hello@hinterland.camp',
		]);
	});

	it('team + personal renders optgroups labelled by mailbox, team group first', () => {
		const availableIdentities: SendAsIdentity[] = [
			identity({ address: 'team@hinterland.camp', kind: 'team', label: 'Support' }),
			identity({
				address: 'b@hinterland.camp',
				mailboxId: mb('mb-personal'),
				kind: 'personal',
				label: 'Bo',
			}),
		];
		const wrapper = mount(PostboxComposerEnvelope, {
			...mountOpts,
			props: { ...baseProps, availableIdentities },
		});
		const groups = wrapper.findAll('optgroup');
		expect(groups).toHaveLength(2);
		// Team group first, then the personal mailbox — server order preserved.
		expect(groups[0]!.attributes('label')).toBe('Support');
		expect(groups[1]!.attributes('label')).toBe('Bo');
		expect(groups[0]!.find('option').attributes('value')).toBe('team@hinterland.camp');
		expect(groups[1]!.find('option').attributes('value')).toBe('b@hinterland.camp');
	});

	it('a single identity hides the picker entirely', () => {
		const availableIdentities: SendAsIdentity[] = [
			identity({ address: 'solo@hinterland.camp', mailboxId: mb('mb-solo'), label: 'Solo' }),
		];
		const wrapper = mount(PostboxComposerEnvelope, {
			...mountOpts,
			props: { ...baseProps, availableIdentities },
		});
		expect(wrapper.find('[data-testid="postbox-from-select"]').exists()).toBe(false);
	});
});

describe('PostboxComposerEnvelope — From picker authenticity (disable-with-reason)', () => {
	it('disables a misaligned identity and shows its plain-language reason', () => {
		const reason =
			'This transport signs and bounces mail as “sendgrid.net”, which isn’t part of “acme.com”.';
		const availableIdentities: SendAsIdentity[] = [
			// Selected identity is the misaligned one.
			identity({ address: 'ceo@acme.com', alignment: 'misaligned', alignmentReason: reason }),
			identity({ address: 'ops@acme.com' }),
		];
		const wrapper = mount(PostboxComposerEnvelope, {
			...mountOpts,
			props: { ...baseProps, fromAddress: 'ceo@acme.com', availableIdentities },
		});
		// The misaligned option is disabled so it can't be picked.
		const misaligned = wrapper
			.findAll('option')
			.find((o) => o.attributes('value') === 'ceo@acme.com');
		expect(misaligned?.attributes('disabled')).toBeDefined();
		// The reason is surfaced under the picker.
		expect(wrapper.text()).toContain('Sender not aligned');
		expect(wrapper.text()).toContain(reason);
	});

	it('disables an unverified-domain identity', () => {
		const availableIdentities: SendAsIdentity[] = [
			identity({ address: 'ceo@acme.com', domainVerified: false }),
			identity({ address: 'ops@acme.com' }),
		];
		const wrapper = mount(PostboxComposerEnvelope, {
			...mountOpts,
			props: { ...baseProps, fromAddress: 'ceo@acme.com', availableIdentities },
		});
		const unverified = wrapper
			.findAll('option')
			.find((o) => o.attributes('value') === 'ceo@acme.com');
		expect(unverified?.attributes('disabled')).toBeDefined();
		expect(wrapper.text()).toContain('Domain not verified');
	});

	it('stays quiet (no chip) when the selected identity is verified and aligned', () => {
		const availableIdentities: SendAsIdentity[] = [
			identity({ address: 'team@hinterland.camp' }),
			identity({ address: 'hello@hinterland.camp' }),
		];
		const wrapper = mount(PostboxComposerEnvelope, {
			...mountOpts,
			props: { ...baseProps, fromAddress: 'team@hinterland.camp', availableIdentities },
		});
		expect(wrapper.text()).not.toContain('Sender verified');
		expect(wrapper.text()).not.toContain('Sender not aligned');
		// Neither option is disabled.
		expect(wrapper.findAll('option').every((o) => o.attributes('disabled') === undefined)).toBe(
			true
		);
	});
});
