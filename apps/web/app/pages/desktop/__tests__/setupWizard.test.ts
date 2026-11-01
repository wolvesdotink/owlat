/**
 * /desktop/setup end to end against a scripted provisioning session: the
 * connect form's credentials, the host-key prompt, the configure steps and the
 * config they send, the DNS table with its SPF merge, and the finish screens.
 * The session (`useServerProvisioning`) is the seam; everything the page owns
 * (form state, validation, the config it builds, reachability polling) runs
 * for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, nextTick, reactive, ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import UiInput from '@owlat/ui/components/ui/Input.vue';
import UiSegmentedControl from '@owlat/ui/components/ui/SegmentedControl.vue';
import UiSelect from '@owlat/ui/components/ui/Select.vue';
import { OWN_SEND_PROVIDER_KIND } from '@owlat/shared/sendProviderCatalog';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useWizard } from '~/composables/useWizard';
import DesktopDnsRecordList from '~/components/desktop/DnsRecordList.vue';
import DesktopHostnameOverrides from '~/components/desktop/HostnameOverrides.vue';
import type { ConnectInfo, ProvisionStage } from '~/lib/desktop/provisioning';

const { computeSpfSuggestion } = vi.hoisted(() => ({ computeSpfSuggestion: vi.fn() }));
vi.mock('~/utils/spfCoexistence', () => ({ computeSpfSuggestion }));

import SetupPage from '../setup.vue';

function fakeSession() {
	const stage = ref<ProvisionStage>('idle');
	const connectInfo = ref<ConnectInfo | null>(null);
	const siteUrl = ref('');
	const canOpenWorkspace = ref(false);
	return {
		stage,
		steps: reactive([]),
		logs: ref([]),
		connectInfo,
		summary: ref(null),
		error: ref<string | null>(null),
		failureTail: ref<string[]>([]),
		secretsRemoved: ref(false),
		leftoverConfigCleanup: ref<string | null>(null),
		busy: ref(false),
		progress: computed(() => 0),
		siteUrl,
		publicIp: ref(''),
		canOpenWorkspace,
		connect: vi.fn(async () => {}),
		acceptHostKey: vi.fn(async () => {}),
		provision: vi.fn(async () => {}),
		verifySiteReachable: vi.fn(async () => {}),
		connectWorkspace: vi.fn(async () => {}),
		disconnect: vi.fn(async () => {}),
		retry: vi.fn(),
	};
}

let session: ReturnType<typeof fakeSession>;

beforeEach(() => {
	session = fakeSession();
	computeSpfSuggestion.mockReset();
	computeSpfSuggestion.mockResolvedValue(null);
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useRoute', () => ({ query: {} }));
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop: ref(true) }));
	vi.stubGlobal('useServerProvisioning', () => session);
	vi.stubGlobal('useWizard', useWizard);
	vi.stubGlobal('useCopyToClipboard', () => ({ copy: vi.fn(), isCopied: () => false }));
});

afterEach(() => {
	vi.useRealTimers();
});

function mountPage() {
	return mount(SetupPage, {
		global: {
			plugins: [createTestI18n()],
			components: {
				UiInput,
				UiSegmentedControl,
				UiSelect,
				DesktopDnsRecordList,
				DesktopHostnameOverrides,
			},
			stubs: {
				DesktopTitlebar: true,
				DesktopProvisioningTimeline: true,
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot/></a>' },
			},
		},
	});
}

const byText = (w: VueWrapper, selector: string, text: string) => {
	const found = w.findAll(selector).find((el) => el.text().includes(text));
	if (!found) throw new Error(`no ${selector} with "${text}"`);
	return found;
};

async function goToStep(w: VueWrapper, label: string) {
	await byText(w, '[role="radio"], button', label).trigger('click');
	await nextTick();
}

// A loopback host is a local install: no domain is required.
async function enterConfigure(w: VueWrapper, host = '127.0.0.1') {
	await w.get('input[placeholder="203.0.113.5 or vps.example.com"]').setValue(host);
	session.stage.value = 'configure';
	await nextTick();
}

describe('/desktop/setup: connect', () => {
	it('asks for the server address before connecting', async () => {
		const w = mountPage();
		await w.get('form').trigger('submit');
		expect(w.text()).toContain('Enter the server address.');
		expect(session.connect).not.toHaveBeenCalled();
	});

	it('connects with a pasted key and the default install directory', async () => {
		const w = mountPage();
		await w
			.get('input[placeholder="203.0.113.5 or vps.example.com"]')
			.setValue(' vps.example.com ');
		await w.get('input[placeholder="Key passphrase (optional)"]').setValue('');
		await byText(w, 'button', 'Paste the key instead').trigger('click');
		await w.get('form').trigger('submit');
		expect(w.text()).toContain('Paste your private key.');

		await w.get('textarea').setValue('-----BEGIN OPENSSH PRIVATE KEY-----');
		await w.get('form').trigger('submit');

		expect(session.connect).toHaveBeenCalledWith({
			host: 'vps.example.com',
			port: 22,
			username: 'root',
			auth: {
				type: 'key',
				privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----',
				passphrase: undefined,
			},
			remote: { installDir: '/opt/owlat' },
		});
	});

	it('sends the password and a custom install directory', async () => {
		const w = mountPage();
		await w.get('input[placeholder="203.0.113.5 or vps.example.com"]').setValue('203.0.113.7');
		await byText(w, '[role="radio"], button', 'Password').trigger('click');
		await w.get('input[placeholder="SSH password"]').setValue('hunter2');
		await byText(w, 'button', 'Show advanced').trigger('click');
		const installDir = w
			.findAll('input')
			.find((el) => (el.element as HTMLInputElement).value === '/opt/owlat');
		await installDir!.setValue('/srv/owlat');
		await w.get('form').trigger('submit');

		expect(session.connect).toHaveBeenCalledWith(
			expect.objectContaining({
				host: '203.0.113.7',
				auth: { type: 'password', password: 'hunter2' },
				remote: { installDir: '/srv/owlat' },
			})
		);
	});

	it('holds a changed host key until the change is acknowledged', async () => {
		const w = mountPage();
		session.connectInfo.value = {
			sessionId: 's1',
			fingerprint: 'SHA256:changed',
			knownHostStatus: 'mismatch',
		} as ConnectInfo;
		session.stage.value = 'hostkey';
		await nextTick();

		expect(w.text()).toContain('SHA256:changed');
		const accept = byText(w, 'button', 'Accept changed key & continue');
		expect(accept.attributes('disabled')).toBeDefined();
		await w.get('input[type="checkbox"]').setValue(true);
		expect(accept.attributes('disabled')).toBeUndefined();
		await accept.trigger('click');
		expect(session.acceptHostKey).toHaveBeenCalledWith(true);
	});
});

describe('/desktop/setup: configure', () => {
	it('requires a domain for a remote server', async () => {
		const w = mountPage();
		await enterConfigure(w, 'vps.example.com');
		await goToStep(w, 'Admin');
		await w.get('form').trigger('submit');
		await flushPromises();

		expect(w.text()).toContain('Remote servers need a public domain');
		expect(session.provision).not.toHaveBeenCalled();
	});

	it('jumps to the admin step when the admin fields are not valid', async () => {
		const w = mountPage();
		await enterConfigure(w);
		await goToStep(w, 'Admin');
		await w.get('input[placeholder="admin@example.com"]').setValue('not-an-email');
		await w.get('form').trigger('submit');
		await flushPromises();

		expect(w.text()).toContain('Enter a valid admin email.');
		expect(session.provision).not.toHaveBeenCalled();
	});

	it('provisions with the config the steps collected', async () => {
		const w = mountPage();
		await enterConfigure(w, '203.0.113.7');

		// Features: turn the AI pack on.
		const aiPack = w
			.findAll('label')
			.find((el) => el.text() === 'AI')!
			.get('input[type="checkbox"]');
		await aiPack.setValue(true);

		// Domain: every hostname and the DNS table derive from it.
		await goToStep(w, 'Domain & DNS');
		await w.get('input[placeholder="wolves.ink"]').setValue('owlat.example');
		await nextTick();
		expect(w.text()).toContain('owlat.owlat.example');
		expect(w.text()).toContain('_dmarc.bounce.owlat.example');

		await goToStep(w, 'Admin');
		await w.get('input[placeholder="admin@example.com"]').setValue('admin@owlat.example');
		await w.get('input[placeholder="Your name"]').setValue('Ada Marlow');
		const passwords = w.findAll('input[autocomplete="new-password"]');
		await passwords[0]!.setValue('correct horse battery');
		await passwords[1]!.setValue('correct horse battery');
		await w.get('form').trigger('submit');
		await flushPromises();

		expect(session.provision).toHaveBeenCalledTimes(1);
		const config = session.provision.mock.calls[0]![0] as unknown as Record<string, unknown>;
		expect(config).toMatchObject({
			version: 1,
			deploymentMode: 'selfhost',
			features: { packs: { emailClient: true, marketing: true, ai: true } },
			admin: {
				email: 'admin@owlat.example',
				name: 'Ada Marlow',
				password: 'correct horse battery',
			},
			seedDemo: false,
			sending: { provider: OWN_SEND_PROVIDER_KIND },
			domain: { ehloHostname: 'mail.owlat.example', bounceDomain: 'bounce.owlat.example' },
		});
		expect(config['network']).toMatchObject({ siteUrl: 'https://owlat.owlat.example' });
	});

	it('shows the starter SPF record merged into the one the host already publishes', async () => {
		vi.useFakeTimers();
		computeSpfSuggestion.mockResolvedValue({
			merged: 'v=spf1 include:_spf.other.example a:mail.owlat.example ~all',
		});
		const w = mountPage();
		await enterConfigure(w, '203.0.113.7');
		await goToStep(w, 'Domain & DNS');
		await w.get('input[placeholder="wolves.ink"]').setValue('owlat.example');
		await nextTick();
		expect(computeSpfSuggestion).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(450);
		await flushPromises();

		expect(computeSpfSuggestion).toHaveBeenCalledTimes(1);
		expect(computeSpfSuggestion.mock.calls[0]![0]).toBe('bounce.owlat.example');
		expect(w.text()).toContain('v=spf1 include:_spf.other.example a:mail.owlat.example ~all');
		expect(w.text()).toContain('merged with the existing SPF record');
	});
});

describe('/desktop/setup: finish', () => {
	it('opens the workspace once the server is ready', async () => {
		const w = mountPage();
		session.siteUrl.value = 'https://owlat.owlat.example';
		session.canOpenWorkspace.value = true;
		session.secretsRemoved.value = true;
		session.stage.value = 'done';
		await nextTick();

		expect(w.text()).toContain('Your server is ready');
		expect(w.text()).toContain('The setup file');
		await byText(w, 'button', 'Open workspace').trigger('click');
		expect(session.connectWorkspace).toHaveBeenCalled();
	});

	it('keeps checking an installed server until it answers, and stops on leave', async () => {
		vi.useFakeTimers();
		const w = mountPage();
		session.siteUrl.value = 'https://owlat.owlat.example';
		session.stage.value = 'done';
		await nextTick();
		await flushPromises();

		expect(w.text()).toContain('Finishing up');
		expect(session.verifySiteReachable).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(5000);
		expect(session.verifySiteReachable).toHaveBeenCalledTimes(2);

		w.unmount();
		expect(session.disconnect).toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(session.verifySiteReachable).toHaveBeenCalledTimes(2);
	});

	it('names the failure, its output and the leftover setup file', async () => {
		const w = mountPage();
		session.error.value = 'docker compose up failed';
		session.failureTail.value = ['Error: port 443 in use'];
		session.leftoverConfigCleanup.value = 'rm -f /opt/owlat/.owlat-setup.json';
		session.stage.value = 'error';
		await nextTick();

		expect(w.text()).toContain('Provisioning failed');
		expect(w.text()).toContain('docker compose up failed');
		expect(w.text()).toContain('Error: port 443 in use');
		expect(w.text()).toContain('rm -f /opt/owlat/.owlat-setup.json');
		await byText(w, 'button', 'Adjust & retry').trigger('click');
		expect(session.retry).toHaveBeenCalled();
	});
});
