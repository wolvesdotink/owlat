/**
 * The shared form and status of one AI draft run per kind and owner, apart
 * from the run itself (`useEmailGeneration`). The hosts that offer the generator read only
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

/**
 * Whose form and run this is: this member in this organisation. Switching
 * organisation keeps the app running, so the state is kept per owner; a
 * prompt, a pick or a finished draft of one organisation must not show up in
 * another.
 */
export function useEmailGenerationOwner() {
	const { user, activeOrganizationId } = useAuth();
	return computed(() => `${user.value?.id ?? ''}:${activeOrganizationId.value ?? ''}`);
}

/** Every owner's state, keyed `<owner>:<kind>`. */
export function useEmailGenerationStates() {
	return useState<Record<string, GenerationState>>('email-generation', () => ({}));
}

export function useEmailGenerationState(kind: GenerationKind) {
	const states = useEmailGenerationStates();
	const owner = useEmailGenerationOwner();
	const key = computed(() => `${owner.value}:${kind}`);
	// The entry exists before anything reads it, so a write through `.value`
	// always lands in the shared state. Sync: the owner can change between two
	// reads in one tick.
	watch(
		key,
		(current) => {
			states.value[current] ??= blankGenerationState();
		},
		{ immediate: true, flush: 'sync' }
	);
	return computed<GenerationState>({
		get: () => states.value[key.value] ?? blankGenerationState(),
		set: (next) => {
			states.value[key.value] = next;
		},
	});
}

/** Whether a run of this kind is in flight, for a host that reopens on it. */
export function useEmailGenerationInFlight(kind: GenerationKind) {
	const state = useEmailGenerationState(kind);
	return computed(() => state.value.status === 'generating');
}
