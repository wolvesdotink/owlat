import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { ConvexClient } from 'convex/browser';
import { decideServiceWorkerAction, isOwnServiceWorker, workerUrlFor } from '~/utils/offlineShell';
import {
	applicationServerKeyBytes,
	describeDevice,
	subscriptionMatchesKey,
	webPushSupport,
	type WebPushSupport,
} from '~/utils/webPush';

/** How long to wait for the worker to activate before giving up on enabling. */
const WORKER_READY_TIMEOUT_MS = 15_000;
/** Sign-out never waits longer than this on releasing the device. */
const RELEASE_TIMEOUT_MS = 2_500;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			timer = setTimeout(() => reject(new Error('timeout')), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

/** This browser's push subscription, if it has one. Never prompts, never registers. */
async function currentSubscription(): Promise<PushSubscription | null> {
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
	try {
		const registration = await navigator.serviceWorker.getRegistration('/');
		return (await registration?.pushManager?.getSubscription()) ?? null;
	} catch {
		return null;
	}
}

/**
 * Sign-out: stop this device from notifying the person who is leaving. The
 * browser profile may be someone else's next, and a notification is the one
 * thing that would still reach them after the session is gone. Best effort and
 * bounded as a whole — the subscription lookup and the browser's unsubscribe
 * can stall on the push service too, and sign-out never waits on any of it for
 * longer than `RELEASE_TIMEOUT_MS`. Never rejects.
 */
export async function releaseWebPushOnSignOut(convex: ConvexClient | null): Promise<void> {
	await withTimeout(releaseDevice(convex), RELEASE_TIMEOUT_MS).catch(() => {});
}

async function releaseDevice(convex: ConvexClient | null): Promise<void> {
	const subscription = await currentSubscription();
	if (!subscription) return;
	// Side by side, so a slow server cannot use up the time the local unsubscribe
	// needs. Either one alone ends delivery: the server prunes a row the first
	// time the push service answers 410 for it.
	await Promise.allSettled([
		convex?.mutation(api.push.subscriptions.remove, { endpoint: subscription.endpoint }),
		subscription.unsubscribe(),
	]);
}

/**
 * Web Push on this device: whether it can work here, whether it is on, and the
 * person's other devices. Permission is only ever requested from `enable`,
 * i.e. from a click — never on page load.
 */
export function useWebPush() {
	const { isDesktop } = useDesktopContext();
	const config = useRuntimeConfig();
	const { t } = useI18n();
	const { showToast } = useToast();

	const support = ref<WebPushSupport>('unsupported');
	const permission = ref<NotificationPermission | 'unknown'>('unknown');
	const endpoint = ref<string | null>(null);
	/** The browser-side state has been read (support, permission, subscription). */
	const isProbed = ref(false);
	const isBusy = ref(false);

	onMounted(async () => {
		support.value = webPushSupport({
			hasServiceWorker: 'serviceWorker' in navigator,
			hasPushManager: 'PushManager' in window,
			hasNotification: 'Notification' in window,
			isSecureContext: window.isSecureContext,
			userAgent: navigator.userAgent,
			maxTouchPoints: navigator.maxTouchPoints ?? 0,
			isStandalone:
				window.matchMedia?.('(display-mode: standalone)').matches === true ||
				(navigator as Navigator & { standalone?: boolean }).standalone === true,
		});
		permission.value = 'Notification' in window ? Notification.permission : 'unknown';
		endpoint.value = (await currentSubscription())?.endpoint ?? null;
		isProbed.value = true;
	});

	// The desktop app has native notifications; Web Push is a browser feature.
	const {
		data: status,
		isLoading,
		error,
		refetch,
	} = useConvexQuery(api.push.subscriptions.status, () =>
		isDesktop.value || !isProbed.value ? 'skip' : endpoint.value ? { endpoint: endpoint.value } : {}
	);

	const isConfigured = computed(() => status.value?.isConfigured === true);
	const devices = computed(() => status.value?.devices ?? []);
	const isPrivate = computed(() => status.value?.isPrivate === true);
	const isEnabledHere = computed(
		() => permission.value === 'granted' && devices.value.some((device) => device.isCurrent)
	);

	const subscribeOp = useBackendOperation(api.push.subscriptions.subscribe, {
		label: () => t('components.preferences.webPush.operations.enable'),
	});
	const removeOp = useBackendOperation(api.push.subscriptions.remove, {
		label: () => t('components.preferences.webPush.operations.remove'),
	});
	const testOp = useBackendOperation(api.push.subscriptions.sendTest, {
		label: () => t('components.preferences.webPush.operations.test'),
	});
	const privateOp = useBackendOperation(api.push.subscriptions.setPrivate, {
		label: () => t('components.preferences.webPush.operations.private'),
	});

	/**
	 * The worker registration push lives on. Reuses ours when it is installed;
	 * otherwise registers the full shell where the shell may run, and the
	 * push-only script where it may not (dev server, kill switch).
	 */
	async function ensureRegistration(): Promise<ServiceWorkerRegistration> {
		const existing = await navigator.serviceWorker.getRegistration('/');
		if (!existing || !isOwnServiceWorker(existing)) {
			const action = decideServiceWorkerAction({
				supported: true,
				isDesktopBuild: false,
				isDev: import.meta.dev,
				enabled: config.public.offlineShell !== false,
			});
			await navigator.serviceWorker.register(workerUrlFor(action), { scope: '/' });
		}
		return withTimeout(navigator.serviceWorker.ready, WORKER_READY_TIMEOUT_MS);
	}

	/** Ask for permission (this is the click), subscribe this browser, register it. */
	async function enable(): Promise<void> {
		const publicKey = status.value?.publicKey;
		if (!publicKey || isBusy.value) return;
		isBusy.value = true;
		try {
			if (Notification.permission === 'default') {
				permission.value = await Notification.requestPermission();
			} else {
				permission.value = Notification.permission;
			}
			if (permission.value !== 'granted') return;

			const registration = await ensureRegistration();
			let subscription = await registration.pushManager.getSubscription();
			// A pair rotated by the operator leaves a subscription nobody can push to.
			if (
				subscription &&
				!subscriptionMatchesKey(subscription.options?.applicationServerKey, publicKey)
			) {
				await subscription.unsubscribe();
				subscription = null;
			}
			subscription ??= await registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: applicationServerKeyBytes(publicKey),
			});
			const keys = subscription.toJSON().keys ?? {};
			const result = await subscribeOp.run({
				endpoint: subscription.endpoint,
				p256dh: keys['p256dh'] ?? '',
				auth: keys['auth'] ?? '',
				label: describeDevice(navigator.userAgent, navigator.maxTouchPoints ?? 0),
				timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			});
			if (result.ok) endpoint.value = subscription.endpoint;
		} catch {
			showToast(t('components.preferences.webPush.enableFailed'), 'error');
		} finally {
			isBusy.value = false;
		}
	}

	/** Turn this browser off: forget it on the server, then drop the subscription. */
	async function disable(): Promise<void> {
		if (isBusy.value) return;
		isBusy.value = true;
		try {
			const subscription = await currentSubscription();
			if (subscription) {
				await removeOp.run({ endpoint: subscription.endpoint });
				await subscription.unsubscribe().catch(() => false);
			}
			endpoint.value = null;
		} finally {
			isBusy.value = false;
		}
	}

	async function removeDevice(id: Id<'pushSubscriptions'>): Promise<void> {
		const device = devices.value.find((candidate) => candidate.id === id);
		if (device?.isCurrent) {
			await disable();
			return;
		}
		await removeOp.run({ subscriptionId: id });
	}

	async function sendTest(id: Id<'pushSubscriptions'>): Promise<void> {
		const result = await testOp.run({ subscriptionId: id });
		if (result.ok) showToast(t('components.preferences.webPush.testSent'), 'success');
	}

	async function setPrivate(value: boolean): Promise<void> {
		await privateOp.run({ isPrivate: value });
	}

	return {
		isDesktop,
		support,
		permission,
		isProbed,
		isLoading,
		error,
		refetch,
		isBusy,
		isConfigured,
		isEnabledHere,
		isPrivate,
		devices,
		enable,
		disable,
		removeDevice,
		sendTest,
		setPrivate,
	};
}
