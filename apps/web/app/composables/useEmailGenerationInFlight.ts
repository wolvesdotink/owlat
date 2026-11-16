/**
 * The shared form and status of one AI draft run per kind, apart from the run
 * itself (`useEmailGeneration`). The hosts that offer the generator read only
 * whether a run is in flight, to reopen on it; importing this keeps the
 * generator, its backend reference and its error handling out of their
 * chunks.
 */
import type { EmailReference, GenerationFailure, Submission } from '~/lib/emailGeneration';
import type { GenerationKind } from '~/lib/emailGenerationEntry';

export interface GenerationState {
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

export const blankGenerationState = (): GenerationState => ({
	prompt: '',
	references: [],
	matchStyle: true,
	name: '',
	slug: '',
	status: 'idle',
	failure: null,
	submission: null,
});

export function useEmailGenerationState(kind: GenerationKind) {
	return useState<GenerationState>(`email-generation:${kind}`, blankGenerationState);
}

/** Whether a run of this kind is in flight, for a host that reopens on it. */
export function useEmailGenerationInFlight(kind: GenerationKind) {
	const state = useEmailGenerationState(kind);
	return computed(() => state.value.status === 'generating');
}
