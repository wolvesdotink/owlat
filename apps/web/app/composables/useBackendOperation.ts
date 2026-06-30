import type { FunctionReference, FunctionArgs, FunctionReturnType } from 'convex/server';
import type { Ref } from 'vue';
import {
	normalizeToOperationError,
	categoryTreatment,
	operationCopy,
} from '~/lib/operationError';

export interface BackendOperationOptions {
	/** Short human label for the operation — used in telemetry on genuine faults. */
	label: string;
	/** `'mutation'` (default) or `'action'`. The udf type isn't on the reference at runtime. */
	type?: 'mutation' | 'action';
	/**
	 * Bind to surface `invalid_input` / `already_exists` failures inline (e.g. on
	 * a form field) instead of as a toast. When omitted, those categories toast.
	 */
	inlineTarget?: Ref<string | null>;
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
export function useBackendOperation<
	M extends FunctionReference<'mutation' | 'action'>,
>(
	operation: M,
	opts: BackendOperationOptions,
): {
	run: (args: FunctionArgs<M>) => Promise<FunctionReturnType<M> | undefined>;
	isLoading: Readonly<Ref<boolean>>;
	inlineError: Readonly<Ref<string | null>>;
} {
	const client = useConvex();
	const { showToast } = useToast();
	const posthog = usePostHog();

	const isLoading = ref(false);
	const wantsInline = opts.inlineTarget !== undefined;
	const inlineError: Ref<string | null> = opts.inlineTarget ?? ref<string | null>(null);

	function applyTreatment(e: unknown): void {
		const op = normalizeToOperationError(e);
		const treatment = categoryTreatment(op.category);
		const copy = operationCopy(op);

		if (treatment.report) {
			posthog.captureError(e, {
				$exception_source: 'backend_operation',
				operation_label: opts.label,
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

	const run = async (
		args: FunctionArgs<M>,
	): Promise<FunctionReturnType<M> | undefined> => {
		inlineError.value = null;

		if (!client) {
			showToast('Something went wrong. Please try again.', 'error');
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
