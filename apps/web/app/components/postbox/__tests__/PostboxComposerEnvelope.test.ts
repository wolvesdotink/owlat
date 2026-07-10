// @vitest-environment happy-dom
/**
 * The composer's From-picker grouping:
 *   - a single mailbox with only aliases (no personal send-as) renders FLAT
 *     options — group headings would just be noise;
 *   - a shared inbox that also offers the teammate's personal identity renders
 *     one <optgroup> per mailbox, labelled by the mailbox, with the TEAM group
 *     first (server order is preserved).
 *
 * The recipient fields are stubbed — only the From <select> is under test.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import type { Id } from '@owlat/api/dataModel';
import type { SendAsIdentity } from '~/composables/postbox/usePostboxCompose';
import PostboxComposerEnvelope from '../PostboxComposerEnvelope.vue';

function mb(id: string): Id<'mailboxes'> {
	return id as Id<'mailboxes'>;
}

const mountOpts = {
	global: {
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
			{ address: 'team@hinterland.camp', mailboxId: mb('mb-team'), kind: 'own', label: 'Team' },
			{ address: 'hello@hinterland.camp', mailboxId: mb('mb-team'), kind: 'own', label: 'Team' },
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
			{ address: 'team@hinterland.camp', mailboxId: mb('mb-team'), kind: 'team', label: 'Support' },
			{ address: 'b@hinterland.camp', mailboxId: mb('mb-personal'), kind: 'personal', label: 'Bo' },
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
			{ address: 'solo@hinterland.camp', mailboxId: mb('mb-solo'), kind: 'own', label: 'Solo' },
		];
		const wrapper = mount(PostboxComposerEnvelope, {
			...mountOpts,
			props: { ...baseProps, availableIdentities },
		});
		expect(wrapper.find('[data-testid="postbox-from-select"]').exists()).toBe(false);
	});
});
