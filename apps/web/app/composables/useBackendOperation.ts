import type { FunctionReference, FunctionArgs, FunctionReturnType } from 'convex/server';
import type { Ref } from 'vue';
import type { OperationError } from '@owlat/shared/operationError';
import { normalizeToOperationError, categoryTreatment, operationCopy } from '~/lib/operationError';

export interface BackendOperationOptions {
	/**
	 * Short human label for the operation — used in telemetry on genuine faults.
	 *
	 * Pass a GETTER on a localized surface. A plain `t('…')` is evaluated once,
	 * while the composable is set up, so it would freeze the label at whatever
	 * locale was active then and keep reporting that one after a locale change;
	 * a getter is called at report time and always matches the UI the member was
	 * looking at when the operation failed.
	 */
	label: string | (() => string);
	/** `'mutation'` (default) or `'action'`. The udf type isn't on the reference at runtime. */
	type?: 'mutation' | 'action';
	/**
	 * Bind to surface `invalid_input` / `already_exists` failures inline (e.g. on
	 * a form field) instead of as a toast. When omitted, those categories toast.
	 */
	inlineTarget?: Ref<string | null>;
	/**
	 * Last look at a normalized failure BEFORE the category → treatment policy
	 * runs. Return `true` to claim it: the default surface (toast / inline /
	 * redirect) and the telemetry report are both skipped, because the caller has
	 * taken responsibility for showing the user something better.
	 *
	 * This is NOT a general escape hatch from ADR-0036's one policy — it exists
	 * for the narrow case where a backend refusal is not really a fault but an
	 * OFFER the caller can render as a normal UI state. The campaign capacity
	 * gate is the motivating case: `exceeds_sending_capacity` hands back a
	 * structured multi-day schedule, and a red toast is precisely the wrong
	 * treatment for "sending over 4 days" (deliverability plan D14 — a multi-day
	 * send is a normal, visible state, never an error and never a surprise).
	 *
	 * Return `false` (or omit the option) and nothing changes.
	 */
	onError?: (error: OperationError) => boolean;
}

/**
 * The **Operation module** for writes (ADR-0036): run a Convex mutation/action,
 * normalize any throw into the shared `{ category, message, data? }` vocabulary,
 * and apply the one category → treatment policy (toast vs inline vs redirect,
 * and the single telemetry decision). Callers pass a function reference + a
 * label; the only knob is the optional `inlineTarget`. Collapses the hand-rolled
 * `try/catch/toast/finally` block every caller used to repeat.
 *
 * Scope: Convex function references only. The few remaining hand-rolled
 * try/catch+toast blocks (settings/team.vue's BetterAuth client calls,
 * ExportModal's client-side CSV download) are deliberately outside this
 * module — they don't go through the Convex client, so the error vocabulary
 * and telemetry policy here don't apply to them.
 */
export function useBackendOperation<M extends FunctionReference<'mutation' | 'action'>>(
	operation: M,
	opts: BackendOperationOptions
): {
	run: (args: FunctionArgs<M>) => Promise<FunctionReturnType<M> | undefined>;
	isLoading: Readonly<Ref<boolean>>;
	inlineError: Readonly<Ref<string | null>>;
} {
	const client = useConvex();
	const { t } = useI18n();
	const { showToast } = useToast();
	const posthog = usePostHog();

	const isLoading = ref(false);
	const wantsInline = opts.inlineTarget !== undefined;
	const inlineError: Ref<string | null> = opts.inlineTarget ?? ref<string | null>(null);

	function applyTreatment(e: unknown): void {
		const op = normalizeToOperationError(e);
		// Claimed by the caller — it is rendering this failure itself, so neither
		// the default surface nor the telemetry report applies.
		if (opts.onError?.(op) === true) return;
		const treatment = categoryTreatment(op.category);
		// `operationCopy` is module scope, so it hands back either a message KEY
		// (copy this app owns) or the backend's own sentence, which must NOT go
		// through `t()` — it is arbitrary text the compiler would read as syntax.
		const copySource = operationCopy(op);
		const copy = 'key' in copySource ? t(copySource.key) : copySource.text;

		if (treatment.report) {
			posthog.captureError(e, {
				$exception_source: 'backend_operation',
				operation_label: typeof opts.label === 'function' ? opts.label() : opts.label,
				error_category: op.category,
			});
		}

		switch (treatment.surface) {
			case 'redirect':
				showToast(copy, 'error');
				void navigateTo('/auth/login');
				break;
			case 'inline':
				if (wantsInline) {
					inlineError.value = copy;
				} else {
					showToast(copy, 'error');
				}
				break;
			case 'toast':
				showToast(copy, 'error');
				break;
		}
	}

	const run = async (args: FunctionArgs<M>): Promise<FunctionReturnType<M> | undefined> => {
		inlineError.value = null;

		if (!client) {
			showToast(t('shared.useBackendOperation.genericError'), 'error');
			return undefined;
		}

		isLoading.value = true;
		try {
			const result =
				opts.type === 'action'
					? await client.action(operation as FunctionReference<'action'>, args)
					: await client.mutation(operation as FunctionReference<'mutation'>, args);
			return result as FunctionReturnType<M>;
		} catch (e) {
			applyTreatment(e);
			return undefined;
		} finally {
			isLoading.value = false;
		}
	};

	return {
		run,
		isLoading: readonly(isLoading),
		inlineError: readonly(inlineError),
	};
}
