import { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import {
	classifyGenerationFailure,
	draftPath,
	generationRequest,
	nextSubmission,
	removeReference,
	type GenerationKind,
} from '~/lib/emailGeneration';
import {
	blankGenerationState as blank,
	useEmailGenerationOwner,
	useEmailGenerationState,
	useEmailGenerationStates,
} from './useEmailGenerationInFlight';

export type GenerationResult = FunctionReturnType<typeof api.emailGeneration.generate.generate>;

/**
 * The open dialog's success handler per owner and kind (`<owner>:<kind>`);
 * absent while every dialog is closed.
 */
const hosts = new Map<string, (result: GenerationResult) => void>();

/**
 * 128 random bits as hex. Not `crypto.randomUUID`, which only exists in a
 * secure context, and an instance may be reached over plain HTTP.
 */
function newRequestId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * One AI draft run per kind, shared by every surface that opens the generator.
 *
 * The author waits in the dialog: the action creates the draft in its one
 * commit and answers with its id, so there is no placeholder row to clean up
 * when a run fails. The run and the form live here, not in the dialog, so
 * closing the dialog mid-run neither loses nor repeats the draft: the run
 * keeps going, reopening shows it still in progress (it cannot be sent a
 * second time), and when it lands with no dialog open a toast offers the
 * draft. A failure keeps the prompt and the picks for the next try (less a
 * pick the server no longer finds), and the request id too while the form is
 * unchanged, so a retry of a run whose answer
 * was lost gets the draft it made, not a second one.
 *
 * A run belongs to the member and organisation that started it. If the member
 * has switched organisation or signed out by the time it lands, its outcome
 * is filed under its owner and nothing is shown: the draft's link would open
 * nothing in the organisation now on screen.
 */
export function useEmailGeneration(kind: GenerationKind) {
	const { t } = useI18n();
	const { showToast } = useToast();
	const states = useEmailGenerationStates();
	const owner = useEmailGenerationOwner();
	const state = useEmailGenerationState(kind);
	const ownerKey = () => `${owner.value}:${kind}`;

	const { run } = useBackendOperation(api.emailGeneration.generate.generate, {
		type: 'action',
		label: () => t('components.ai.emailGenerate.operation'),
	});

	const isGenerating = computed(() => state.value.status === 'generating');

	async function generate(extra: { defaultLanguage?: string } = {}): Promise<void> {
		if (isGenerating.value) return;
		const request = generationRequest(kind, {
			prompt: state.value.prompt,
			references: state.value.references,
			matchStyle: state.value.matchStyle,
			...(kind === 'transactional' ? { name: state.value.name, slug: state.value.slug } : {}),
			...extra,
		});
		if (!request.ok) return;
		// Everything below writes to the form that started the run, whoever is
		// on screen when it lands.
		const startedBy = ownerKey();
		const form = state.value;
		const submission = nextSubmission(form.submission, request.args, newRequestId);
		form.submission = submission;
		form.status = 'generating';
		form.failure = null;
		const outcome = await run(
			// The reference ids came from the picker's own query, so they are document ids.
			{ ...request.args, requestId: submission.requestId } as Parameters<typeof run>[0],
			{
				// Every failure is shown in the dialog, next to the prompt it keeps.
				onError: (error) => {
					const failure = classifyGenerationFailure(error);
					form.failure = failure;
					// A pick the server could not find leaves this form, dialog open
					// or not, so the next try can go.
					if (failure.kind === 'reference_missing' && failure.referenceId) {
						form.references = removeReference(form.references, failure.referenceId);
					}
					return true;
				},
			}
		);
		if (!outcome.ok) {
			form.status = 'failed';
			return;
		}
		states.value[startedBy] = blank();
		if (ownerKey() !== startedBy) return;
		const host = hosts.get(startedBy);
		if (host) {
			host(outcome.result);
			return;
		}
		showToast(t('components.ai.emailGenerate.readyToast'), 'success', {
			durationMs: 0,
			action: {
				label: t('components.ai.emailGenerate.openDraft'),
				// The toast stays until it is dismissed, so the owner can change under it.
				onAction: () => {
					if (ownerKey() === startedBy) void navigateTo(draftPath(outcome.result));
				},
			},
		});
	}

	/**
	 * Register the open dialog as the one that takes the result. The dialog
	 * shows whichever owner is signed in now, so the registration follows the
	 * owner while the dialog stays open; detaching removes it from the key it
	 * is under by then.
	 */
	function attach(handler: (result: GenerationResult) => void): () => void {
		let key = ownerKey();
		hosts.set(key, handler);
		const stop = watch(
			owner,
			() => {
				if (hosts.get(key) === handler) hosts.delete(key);
				key = ownerKey();
				hosts.set(key, handler);
			},
			// Sync: a run started right after the switch must find the handler.
			{ flush: 'sync' }
		);
		return () => {
			stop();
			if (hosts.get(key) === handler) hosts.delete(key);
		};
	}

	function dismissFailure(): void {
		if (state.value.status === 'failed') state.value.status = 'idle';
		state.value.failure = null;
	}

	return { state, isGenerating, generate, attach, dismissFailure };
}
