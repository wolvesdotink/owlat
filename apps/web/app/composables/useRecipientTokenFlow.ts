import { computed, onMounted, ref, type Ref } from 'vue';
import { PUBLIC_TOKEN_REASONS, type PublicTokenResult } from '~/lib/publicTokenClient';

/**
 * The token flow behind every recipient page (unsubscribe, preferences,
 * double opt-in, share, archive): read `?token=`, verify it on mount, then run
 * the page's one action with it.
 *
 *   loading ──verify──▶ ready ──run──▶ done
 *      │                  │
 *      └──────────────────┴──▶ error
 *
 * Every failure lands as an i18n KEY in `errorKey`, picked from the page's
 * reason table with a fallback. The backend's `message` is English and is
 * never shown: the recipient reads this page in their own language. A thrown
 * action (a Convex client call, say) counts as the server being unreachable.
 */

export type RecipientFlowState = 'loading' | 'error' | 'ready' | 'done';

export type RecipientTokenAction<T> = (token: string) => Promise<PublicTokenResult<T>>;

export interface RecipientStepErrors {
	/** For a reason the page's table does not name. */
	fallbackKey: string;
	/**
	 * For a request that never got a readable answer, or an action that threw.
	 * Defaults to `fallbackKey`.
	 */
	unreachableKey?: string;
}

export interface RecipientTokenFlowOptions<V> extends RecipientStepErrors {
	/** Resolves the token into what the page renders; runs on mount. */
	verify: RecipientTokenAction<V>;
	/** Shown when the link carries no token at all. */
	missingTokenKey: string;
	/** `reason` → i18n key, shared by the verify step and every action. */
	reasons?: Record<string, string>;
}

export interface RecipientRunOptions extends RecipientStepErrors {
	/**
	 * Leave `state` alone on either outcome: a failure only sets `errorKey`, so
	 * the page can show it next to the form it came from.
	 */
	inline?: boolean;
}

/** Shown for a rate-limited request unless the page's table says otherwise. */
const RATE_LIMITED_KEY = 'recipient.shared.rateLimited';

const UNREACHABLE = new Set<string>([
	PUBLIC_TOKEN_REASONS.network,
	PUBLIC_TOKEN_REASONS.badResponse,
]);

export function useRecipientTokenFlow<V>(options: RecipientTokenFlowOptions<V>) {
	const route = useRoute();
	const token = computed(() => {
		const raw = route.query['token'];
		return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
	});

	const state = ref<RecipientFlowState>('loading');
	/** What `verify` resolved to; the page may replace it after an action. */
	const data = ref(null) as Ref<V | null>;
	const errorKey = ref<string | null>(null);
	/** The raw reason behind `errorKey`, for a page with a state of its own (share's "expired"). */
	const reason = ref<string | null>(null);
	const isProcessing = ref(false);

	function keyFor(failure: string, errors: RecipientStepErrors): string {
		const mapped = options.reasons?.[failure];
		if (mapped) return mapped;
		if (failure === PUBLIC_TOKEN_REASONS.rateLimited) return RATE_LIMITED_KEY;
		if (UNREACHABLE.has(failure)) return errors.unreachableKey ?? errors.fallbackKey;
		return errors.fallbackKey;
	}

	async function attempt<T>(
		action: RecipientTokenAction<T>,
		value: string
	): Promise<PublicTokenResult<T>> {
		try {
			return await action(value);
		} catch {
			return { ok: false, reason: PUBLIC_TOKEN_REASONS.network };
		}
	}

	function fail(failure: string, errors: RecipientStepErrors, inline = false): void {
		reason.value = failure;
		errorKey.value = keyFor(failure, errors);
		if (!inline) state.value = 'error';
	}

	/** Run the page's action with the token; resolves to the action's result. */
	async function run<T>(
		action: RecipientTokenAction<T>,
		errors: RecipientRunOptions
	): Promise<PublicTokenResult<T> | null> {
		const value = token.value;
		if (!value || isProcessing.value) return null;
		isProcessing.value = true;
		errorKey.value = null;
		reason.value = null;
		try {
			const result = await attempt(action, value);
			if (!result.ok) fail(result.reason, errors, errors.inline);
			else if (!errors.inline) state.value = 'done';
			return result;
		} finally {
			isProcessing.value = false;
		}
	}

	onMounted(async () => {
		const value = token.value;
		if (!value) {
			reason.value = 'missing_token';
			errorKey.value = options.missingTokenKey;
			state.value = 'error';
			return;
		}
		const result = await attempt(options.verify, value);
		if (!result.ok) {
			fail(result.reason, options);
			return;
		}
		data.value = result.data;
		state.value = 'ready';
	});

	return { token, state, data, errorKey, reason, isProcessing, run };
}
