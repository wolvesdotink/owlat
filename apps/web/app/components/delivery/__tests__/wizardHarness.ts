/**
 * Shared mounting harness for the transport connection wizard's tests (P2-4).
 *
 * The wizard is mounted for REAL — the UI kit and the embedded shipped test-send
 * card are stubbed, nothing else. Every assertion in the four suites is made
 * against rendered output, because the properties under test (an offer that
 * never nags, a secret that never reaches the screen, focus that follows the
 * step) are properties of what an operator actually sees.
 *
 * The credentials step and the finding row are NOT stubbed and are not
 * registered here either: the wizard imports both explicitly, precisely so a
 * mount cannot silently resolve them to nothing and leave four suites asserting
 * against a step that never rendered.
 */
import { vi } from 'vitest';
import { config, flushPromises, mount } from '@vue/test-utils';
import type {
	AlignmentArm,
	ReferenceAlignmentArm,
	ReferenceArmInput,
} from '@owlat/shared/deliverabilityAlignment';
import type { ReturnPathCapabilityValue } from '~/utils/transportWizard';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import TransportConnectionWizard from '../TransportConnectionWizard.vue';

/**
 * THE REAL MESSAGE CATALOG, FOR EVERY SUITE THAT MOUNTS THROUGH THIS HARNESS.
 *
 * The wizard, its credentials step and the transport editor all render their
 * copy through vue-i18n, and `useI18n` is a Nuxt auto-import in the app. Both
 * are installed once here rather than in each suite: these components are
 * mounted from six files (one of them outside this directory), and a suite that
 * forgot either would fail on a missing global rather than on the property it
 * exists to check.
 */
const i18n = createTestI18n();
Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
config.global.plugins = [...(config.global.plugins ?? []), i18n];

/**
 * The wizard's module-scope vocabulary (`utils/transportWizard`) is catalog
 * KEYS, so a suite comparing one of them with the sentence the wizard paints has
 * to resolve it the same way the component does — against the real English
 * catalog, not a restated copy of the words.
 */
export const localized = (value: string | { key: string; params?: Record<string, unknown> }) =>
	typeof value === 'string' ? i18n.global.t(value) : i18n.global.t(value.key, value.params ?? {});

/**
 * A live-DNS fixture: TXT values per name, or an authoritative absence, or a
 * lookup that could not be made. The last two are distinct on purpose — the
 * pre-flight must never launder "we could not find out" into "not published".
 */
export type TxtFixture = Record<string, readonly string[] | 'nxdomain' | 'servfail'>;

/** DoH JSON `Status` codes (RFC 1035 §4.1.1). */
const NOERROR = 0;
const SERVFAIL = 2;
const NXDOMAIN = 3;

/**
 * Stub DNS-over-HTTPS with a fixture. No test in this suite touches the real
 * network — the wizard's alignment step resolves whatever the fixture says and
 * nothing else.
 */
export function stubDoh(fixture: TxtFixture): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) => {
			const name = new URL(url).searchParams.get('name') ?? '';
			const entry = fixture[name];
			if (entry === 'servfail') {
				return { ok: true, json: async () => ({ Status: SERVFAIL }) };
			}
			if (entry === undefined || entry === 'nxdomain') {
				return { ok: true, json: async () => ({ Status: NXDOMAIN, Answer: [] }) };
			}
			return {
				ok: true,
				json: async () => ({
					Status: NOERROR,
					Answer: entry.map((value) => ({ type: 16, data: `"${value}"` })),
				}),
			};
		})
	);
}

/** Turn a field label into the id the stubbed input/label pair share. */
function fieldId(label: string): string {
	return `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/** The own-MTA arm every alignment fixture starts from. */
export const OWN_ARM = {
	label: 'own MTA',
	fromDomain: 'example.com',
	dkimDomain: 'example.com',
	dkimSelectors: ['owlat'],
	spfMechanisms: ['ip4:203.0.113.10'],
} as const;

/** The reference (relay) arm, aligned by default; override one field per case. */
export function referenceArm(overrides: Partial<ReferenceAlignmentArm> = {}): ReferenceArmInput {
	return {
		kind: 'arm',
		arm: {
			label: 'SES relay',
			fromDomain: 'example.com',
			dkimDomain: 'example.com',
			dkimSelectors: ['ses1'],
			spfMechanisms: ['include:amazonses.com'],
			supportsCustomReturnPath: true,
			...overrides,
		},
	};
}

/** The `alignmentArms` prop as the query returns it — domain included. */
export function armsFixture(reference: ReferenceArmInput = referenceArm()): {
	domain: string;
	ownArm: AlignmentArm;
	reference: ReferenceArmInput;
} {
	return { domain: OWN_ARM.fromDomain, ownArm: OWN_ARM, reference };
}

/** Live DNS with everything published correctly for both arms. */
export const ALIGNED_DNS: TxtFixture = {
	'example.com': ['v=spf1 ip4:203.0.113.10 include:amazonses.com ~all'],
	'_dmarc.example.com': ['v=DMARC1; p=reject; rua=mailto:dmarc@example.com'],
	'owlat._domainkey.example.com': ['v=DKIM1; k=rsa; p=OWNKEY'],
	'ses1._domainkey.example.com': ['v=DKIM1; k=rsa; p=RELAYKEY'],
};

export const wizardStubs = {
	Icon: { template: '<i />' },
	UiIconBox: { template: '<i />' },
	UiCard: { template: '<section><slot name="header" /><slot /></section>' },
	UiButton: {
		props: ['disabled', 'loading', 'variant', 'size'],
		emits: ['click'],
		template:
			'<button :disabled="disabled" @click="$emit(\'click\')"><slot /><slot name="iconLeft" /></button>',
	},
	UiInput: {
		props: ['modelValue', 'label', 'type', 'error', 'placeholder', 'autocomplete', 'disabled'],
		emits: ['update:modelValue'],
		methods: { fieldId },
		template: `<span>
			<label :for="fieldId(label)">{{ label }}</label>
			<input :id="fieldId(label)" :type="type || 'text'" :value="modelValue" :disabled="disabled"
				:placeholder="placeholder"
				@input="$emit('update:modelValue', $event.target.value)" />
			<span v-if="error" role="alert">{{ error }}</span>
		</span>`,
	},
	/**
	 * `error` is part of the stub because it is part of the real control:
	 * `packages/ui/components/ui/Select.vue` renders `<p v-if="error">` under the
	 * trigger exactly as `Input.vue` does. Marked `role="alert"` here for the same
	 * reason the input stub is — neither shipped component sets it, and the
	 * attribute is how these suites find "the one message on screen".
	 */
	UiSelect: {
		props: ['modelValue', 'label', 'options', 'error'],
		emits: ['update:modelValue'],
		methods: { fieldId },
		template: `<span>
			<label :for="fieldId(label)">{{ label }}</label>
			<select :id="fieldId(label)" :value="modelValue"
				@change="$emit('update:modelValue', $event.target.value)">
				<option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
			</select>
			<span v-if="error" role="alert">{{ error }}</span>
		</span>`,
	},
	UiErrorAlert: {
		props: ['variant', 'title', 'message'],
		template: '<div><strong>{{ title }}</strong><span>{{ message }}</span></div>',
	},
	/**
	 * The shipped test-send card, reduced to the ONE thing the wizard consumes
	 * from it: the `result` event. Keeping it a stub is the point — the wizard
	 * must not reimplement the send, only listen to it.
	 */
	DeliveryTestSendCard: {
		props: ['canSend'],
		emits: ['result'],
		template: `<div>
			<button class="test-pass" @click="$emit('result', { success: true })">pass</button>
			<button class="test-fail" @click="$emit('result', { success: false })">fail</button>
		</div>`,
	},
};

export interface WizardProps {
	alignmentArms?: { domain: string; ownArm: AlignmentArm; reference: ReferenceArmInput } | null;
	/**
	 * The reference transport step 4 describes. Omitted is the read in flight;
	 * `null` is the resolved "there is no single second arm". The two must render
	 * differently, so the harness keeps them distinguishable.
	 */
	returnPathTransportId?: string | null;
	returnPathCapability?: ReturnPathCapabilityValue | null;
	canSend?: boolean;
}

export function mountWizard(props: WizardProps = {}) {
	return mount(TransportConnectionWizard, {
		props: { canSend: true, ...props },
		global: { stubs: wizardStubs },
		attachTo: document.body,
	});
}

export type WizardWrapper = ReturnType<typeof mountWizard>;

/** Find a rendered button by its exact trimmed label. */
export function buttonByText(wrapper: WizardWrapper, text: string) {
	const button = wrapper.findAll('button').find((node) => node.text().trim() === text);
	if (!button) throw new Error(`No button labelled "${text}" is rendered`);
	return button;
}

/** Open the wizard from its collapsed entry-point card. */
export async function openWizard(wrapper: WizardWrapper): Promise<void> {
	await buttonByText(wrapper, 'Connect a provider').trigger('click');
	await flushPromises();
}

/** The relay kinds the credentials step offers. */
export type WizardRelayKind = 'resend' | 'ses' | 'smtp' | 'mandrill';

/** Select one of the relay kinds on the credentials step. */
export async function chooseProvider(
	wrapper: WizardWrapper,
	value: WizardRelayKind
): Promise<void> {
	const radio = wrapper.find(`input[type="radio"][value="${value}"]`);
	if (!radio.exists()) throw new Error(`No provider radio for "${value}" is rendered`);
	await radio.setValue();
}

/**
 * Fill in whichever credential fields the chosen kind needs. Deliberately not a
 * single "type the secret" helper: the SES and SMTP branches have their own
 * fields, and a suite that only ever exercises Resend proves nothing about them.
 */
export async function fillCredentials(
	wrapper: WizardWrapper,
	value: WizardRelayKind,
	secret = 'super-secret-value'
): Promise<void> {
	await chooseProvider(wrapper, value);
	if (value === 'resend') {
		await wrapper.find('#field-resend-api-key').setValue(secret);
		return;
	}
	if (value === 'mandrill') {
		await wrapper.find('#field-mailchimp-transactional-api-key').setValue(secret);
		return;
	}
	if (value === 'ses') {
		await wrapper.find('#field-region').setValue('us-east-1');
		await wrapper.find('#field-access-key-id').setValue('AKIAEXAMPLE');
		await wrapper.find('#field-secret-access-key').setValue(secret);
		return;
	}
	await wrapper.find('#field-username').setValue('postmaster@example.com');
	await wrapper.find('#field-password').setValue(secret);
}
