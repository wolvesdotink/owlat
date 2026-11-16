import { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import {
	classifyGenerationFailure,
	draftPath,
	generationRequest,
	nextSubmission,
	type EmailReference,
	type GenerationFailure,
	type GenerationKind,
	type Submission,
} from '~/lib/emailGeneration';

export type GenerationResult = FunctionReturnType<typeof api.emailGeneration.generate.generate>;

interface GenerationState {
	prompt: string;
	references: EmailReference[];
	matchStyle: boolean;
	name: string;
	slug: string;
	status: 'idle' | 'generating' | 'failed';
	failure: GenerationFailure | null;
	/** The last submission sent; kept until it succeeds (`nextSubmission`). */
	submission: Submission | null;
}

/** The open dialog's success handler per kind; absent while every dialog is closed. */
const hosts = new Map<GenerationKind, (result: GenerationResult) => void>();

const blank = (): GenerationState => ({
	prompt: '',
	references: [],
	matchStyle: true,
	name: '',
	slug: '',
	status: 'idle',
	failure: null,
	submission: null,
});

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
 * draft. A failure keeps the prompt and the picks for the next try, and the
 * request id too while the form is unchanged, so a retry of a run whose answer
 * was lost gets the draft it made, not a second one.
 */
export function useEmailGeneration(kind: GenerationKind) {
	const { t } = useI18n();
	const { showToast } = useToast();
	const state = useState<GenerationState>(`email-generation:${kind}`, blank);

	const { run } = useBackendOperation(api.emailGeneration.generate.generate, {
		type: 'action',
		label: () => t('components.ai.emailGenerate.operation'),
		// Every failure is shown in the dialog, next to the prompt it keeps.
		onError: (error) => {
			state.value.failure = classifyGenerationFailure(error);
			return true;
		},
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
		const submission = nextSubmission(state.value.submission, request.args, newRequestId);
		state.value.submission = submission;
		state.value.status = 'generating';
		state.value.failure = null;
		// The reference ids came from the picker's own query, so they are document ids.
		const outcome = await run({
			...request.args,
			requestId: submission.requestId,
		} as Parameters<typeof run>[0]);
		if (!outcome.ok) {
			state.value.status = 'failed';
			return;
		}
		state.value = blank();
		const host = hosts.get(kind);
		if (host) {
			host(outcome.result);
			return;
		}
		showToast(t('components.ai.emailGenerate.readyToast'), 'success', {
			durationMs: 0,
			action: {
				label: t('components.ai.emailGenerate.openDraft'),
				onAction: () => void navigateTo(draftPath(outcome.result)),
			},
		});
	}

	/** Register the open dialog as the one that takes the result. */
	function attach(handler: (result: GenerationResult) => void): () => void {
		hosts.set(kind, handler);
		return () => {
			if (hosts.get(kind) === handler) hosts.delete(kind);
		};
	}

	function dismissFailure(): void {
		if (state.value.status === 'failed') state.value.status = 'idle';
		state.value.failure = null;
	}

	return { state, isGenerating, generate, attach, dismissFailure };
}

/** Whether a run of this kind is in flight, for a host that reopens on it. */
export function useEmailGenerationInFlight(kind: GenerationKind) {
	const state = useState<GenerationState>(`email-generation:${kind}`, blank);
	return computed(() => state.value.status === 'generating');
}
