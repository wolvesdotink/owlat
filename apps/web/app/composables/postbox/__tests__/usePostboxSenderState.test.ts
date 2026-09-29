/**
 * usePostboxSenderState — the one client home of the reader's VIP star and
 * "Accept sender" state, shared by PostboxSenderControls and
 * PostboxSenderProfile:
 *   - `canAccept` is the server's answer (the Reply Queue gate's own rule), not
 *     a client restatement, so a shared inbox never offers Accept;
 *   - `isAccepted` is the other side of that answer while the screener is on;
 *   - the query is skipped while disabled or for an address without an `@`;
 *   - both actions run through useBackendOperation with the mailbox + address.
 *
 * The Convex query/operation composables are stubbed as globals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { usePostboxSenderState } from '../usePostboxSenderState';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

type SenderState = {
	isVip: boolean;
	isKnown: boolean;
	isScreenerAccepted: boolean;
	isScreenerEnabled: boolean;
	canAccept: boolean;
};

const data = ref<SenderState | undefined>(undefined);
let queryArgs: () => unknown = () => undefined;
const runs: { label: string; args: unknown }[] = [];
const loading = { vip: ref(false), accept: ref(false) };

function state(overrides: Partial<SenderState> = {}): SenderState {
	return {
		isVip: false,
		isKnown: false,
		isScreenerAccepted: false,
		isScreenerEnabled: false,
		canAccept: false,
		...overrides,
	};
}

beforeEach(() => {
	data.value = undefined;
	runs.length = 0;
	loading.vip.value = false;
	loading.accept.value = false;
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
	vi.stubGlobal('useConvexQuery', (_ref: unknown, args: () => unknown) => {
		queryArgs = args;
		return { data };
	});
	vi.stubGlobal('useBackendOperation', (_ref: unknown, opts: { label: () => string }) => {
		const label = opts.label();
		const isLoading = label.endsWith('vipOperation') ? loading.vip : loading.accept;
		return {
			isLoading,
			run: vi.fn(async (args: unknown) => {
				runs.push({ label, args });
				return { ok: true, result: null };
			}),
		};
	});
});

function setup(opts: { email?: string; enabled?: boolean } = {}) {
	const email = ref(opts.email ?? 'sender@example.com');
	const enabled = ref(opts.enabled ?? true);
	const sender = usePostboxSenderState({ mailboxId: () => 'mailbox-1', email, enabled });
	return { sender, email, enabled };
}

describe('usePostboxSenderState query', () => {
	it('subscribes with the mailbox and address', () => {
		setup();
		expect(queryArgs()).toEqual({ mailboxId: 'mailbox-1', email: 'sender@example.com' });
	});

	it('skips while disabled and for an address without an @', () => {
		const { email, enabled } = setup({ enabled: false });
		expect(queryArgs()).toBe('skip');
		enabled.value = true;
		email.value = 'undisclosed-recipients';
		expect(queryArgs()).toBe('skip');
		email.value = 'back@example.com';
		expect(queryArgs()).toEqual({ mailboxId: 'mailbox-1', email: 'back@example.com' });
	});
});

describe('usePostboxSenderState flags', () => {
	it('reads everything as false while loading', () => {
		const { sender } = setup();
		expect(sender.isVip.value).toBe(false);
		expect(sender.canAccept.value).toBe(false);
		expect(sender.isAccepted.value).toBe(false);
	});

	it('offers Accept exactly when the server says the gate holds the sender back', () => {
		const { sender } = setup();
		data.value = state({ isScreenerEnabled: true, canAccept: true });
		expect(sender.canAccept.value).toBe(true);
		expect(sender.isAccepted.value).toBe(false);
	});

	it('never offers Accept when the server says no, whatever the other flags say', () => {
		// A shared inbox: the screener is off there, so there is nothing to accept,
		// even for an unknown, unaccepted sender.
		const { sender } = setup();
		data.value = state({ isScreenerEnabled: false, canAccept: false });
		expect(sender.canAccept.value).toBe(false);
		expect(sender.isAccepted.value).toBe(false);
	});

	it('reports a known, VIP or accepted sender as accepted while the screener is on', () => {
		const { sender } = setup();
		data.value = state({ isScreenerEnabled: true, isKnown: true, isVip: true });
		expect(sender.isVip.value).toBe(true);
		expect(sender.canAccept.value).toBe(false);
		expect(sender.isAccepted.value).toBe(true);
	});
});

describe('usePostboxSenderState actions', () => {
	it('toggles VIP to the opposite of the current flag', () => {
		const { sender } = setup();
		data.value = state({ isVip: true, isKnown: true });
		sender.toggleVip();
		expect(runs).toEqual([
			{
				label: 'components.postbox.postboxSenderControls.vipOperation',
				args: { mailboxId: 'mailbox-1', email: 'sender@example.com', isVip: false },
			},
		]);
	});

	it('accepts the sender for this mailbox', () => {
		const { sender } = setup();
		sender.acceptSender();
		expect(runs).toEqual([
			{
				label: 'components.postbox.postboxSenderControls.acceptOperation',
				args: { mailboxId: 'mailbox-1', email: 'sender@example.com' },
			},
		]);
	});

	it('does nothing without a usable address', () => {
		const { sender } = setup({ email: 'no-address' });
		sender.toggleVip();
		sender.acceptSender();
		expect(runs).toEqual([]);
	});

	it('is busy while either action runs', () => {
		const { sender } = setup();
		expect(sender.busy.value).toBe(false);
		loading.accept.value = true;
		expect(sender.busy.value).toBe(true);
		loading.accept.value = false;
		loading.vip.value = true;
		expect(sender.busy.value).toBe(true);
	});
});
