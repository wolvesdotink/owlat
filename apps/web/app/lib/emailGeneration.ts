/**
 * Drafting an email with AI, the parts of the generator that are decisions
 * rather than UI: what a request carries, how picked references behave, and
 * which sentence a failure gets. Pure, so the panel, its run and their tests
 * share one answer. Who sees the entry point is `./emailGenerationEntry.ts`,
 * kept apart so the hosts do not load any of this before the generator opens.
 */
import type { GenerationKind } from './emailGenerationEntry';
import { AI_BUDGET_ERROR_CODE } from '@owlat/shared/aiRouting';
import type { OperationError } from '@owlat/shared/operationError';

export type { GenerationKind };
export type ReferenceKind = 'template' | 'transactional' | 'campaign';

export interface EmailReference {
	kind: ReferenceKind;
	id: string;
	name: string;
}

/** Same caps as the backend (`emailGeneration/outputSchema.ts`). */
export const MAX_PROMPT_CHARS = 2_000;
export const MAX_REFERENCES = 3;

const K = 'components.ai.emailGenerate';

/** Example prompts per kind, as message keys; picking one fills the field. */
export const EXAMPLE_PROMPT_KEYS: Record<GenerationKind, readonly string[]> = {
	template: [`${K}.examples.newsletter`, `${K}.examples.welcome`, `${K}.examples.event`],
	transactional: [
		`${K}.examples.booking`,
		`${K}.examples.passwordReset`,
		`${K}.examples.orderShipped`,
	],
	campaign: [`${K}.examples.newsletter`, `${K}.examples.launch`, `${K}.examples.winBack`],
};

/** Add a pick: no duplicates, at most {@link MAX_REFERENCES}. */
export function addReference(
	list: readonly EmailReference[],
	ref: EmailReference
): EmailReference[] {
	if (list.length >= MAX_REFERENCES) return [...list];
	if (list.some((r) => r.kind === ref.kind && r.id === ref.id)) return [...list];
	return [...list, ref];
}

export function removeReference(list: readonly EmailReference[], id: string): EmailReference[] {
	return list.filter((r) => r.id !== id);
}

export interface GenerationForm {
	prompt: string;
	references: readonly EmailReference[];
	matchStyle: boolean;
	defaultLanguage?: string;
	name?: string;
	slug?: string;
}

/** The action's arguments, or why the form cannot be sent yet. */
export function generationRequest(
	kind: GenerationKind,
	form: GenerationForm
):
	| {
			ok: true;
			args: {
				kind: GenerationKind;
				prompt: string;
				references: { kind: ReferenceKind; id: string }[];
				matchStyle: boolean;
				defaultLanguage?: string;
				name?: string;
				slug?: string;
			};
	  }
	| { ok: false; reason: 'empty' | 'too_long' } {
	const prompt = form.prompt.trim();
	if (!prompt) return { ok: false, reason: 'empty' };
	if (prompt.length > MAX_PROMPT_CHARS) return { ok: false, reason: 'too_long' };
	const name = form.name?.trim();
	const slug = form.slug?.trim();
	return {
		ok: true,
		args: {
			kind,
			prompt,
			references: form.references
				.slice(0, MAX_REFERENCES)
				.map(({ kind: k, id }) => ({ kind: k, id })),
			matchStyle: form.matchStyle,
			...(form.defaultLanguage ? { defaultLanguage: form.defaultLanguage } : {}),
			...(name ? { name } : {}),
			...(slug ? { slug } : {}),
		},
	};
}

type GenerationArgs = Extract<ReturnType<typeof generationRequest>, { ok: true }>['args'];

/** The request id a submission is sent under, and the form it was minted for. */
export interface Submission {
	requestId: string;
	form: string;
}

/**
 * The submission to send `args` under. The same form sent again keeps its
 * request id, so a retry after a failure whose outcome the client never saw
 * (a dropped connection after the draft was made) is answered with that draft
 * instead of a second one. Keeping it after a failure the server reported is
 * harmless: that run created nothing, so the server runs the retry afresh. A
 * changed form (prompt, kind, references, style switch, language, name, slug)
 * is a new submission with a new id. A success clears the submission
 * (`useEmailGeneration`), so the next one is new too.
 */
export function nextSubmission(
	previous: Submission | null,
	args: GenerationArgs,
	mint: () => string
): Submission {
	const form = JSON.stringify(args);
	if (previous && previous.form === form) return previous;
	return { requestId: mint(), form };
}

export type GenerationFailure =
	| { kind: 'budget'; reason: string | null }
	| { kind: 'rate_limited' }
	| { kind: 'not_configured' }
	| { kind: 'feature_off' }
	| { kind: 'permission' }
	| { kind: 'reference_missing'; referenceId: string | null }
	| { kind: 'invalid_output' }
	| { kind: 'provider_failed' }
	| { kind: 'slug_taken' }
	| { kind: 'invalid_slug' }
	| { kind: 'invalid_input'; message: string }
	| { kind: 'network' }
	| { kind: 'unknown' };

/** A normalized failure → what the dialog tells the author. Total: every error lands somewhere. */
export function classifyGenerationFailure(error: OperationError): GenerationFailure {
	const data = (error.data ?? {}) as {
		code?: unknown;
		reason?: unknown;
		referenceId?: unknown;
		features?: unknown;
	};
	switch (data.code) {
		case AI_BUDGET_ERROR_CODE:
			return { kind: 'budget', reason: typeof data.reason === 'string' ? data.reason : null };
		case 'AI_NOT_CONFIGURED':
			return { kind: 'not_configured' };
		case 'EMAIL_GENERATION_REFERENCE_MISSING':
			return {
				kind: 'reference_missing',
				referenceId: typeof data.referenceId === 'string' ? data.referenceId : null,
			};
		case 'EMAIL_GENERATION_INVALID_OUTPUT':
			return { kind: 'invalid_output' };
		case 'EMAIL_GENERATION_PROVIDER_FAILED':
			return { kind: 'provider_failed' };
		case 'EMAIL_GENERATION_FORBIDDEN':
			return { kind: 'permission' };
		case 'EMAIL_GENERATION_INVALID_SLUG':
			return { kind: 'invalid_slug' };
	}
	switch (error.category) {
		case 'rate_limited':
			return { kind: 'rate_limited' };
		case 'forbidden':
			return Array.isArray(data.features) ? { kind: 'feature_off' } : { kind: 'permission' };
		case 'already_exists':
			return { kind: 'slug_taken' };
		case 'invalid_input':
			return { kind: 'invalid_input', message: error.message };
		case 'network':
			return { kind: 'network' };
		default:
			return { kind: 'unknown' };
	}
}

/** The message key of a failure (the budget reason has its own catalog). */
export const FAILURE_KEYS: Record<Exclude<GenerationFailure['kind'], 'invalid_input'>, string> = {
	budget: `${K}.errors.budget`,
	rate_limited: `${K}.errors.rateLimited`,
	not_configured: `${K}.errors.notConfigured`,
	feature_off: `${K}.errors.featureOff`,
	permission: `${K}.errors.permission`,
	reference_missing: `${K}.errors.referenceMissing`,
	invalid_output: `${K}.errors.invalidOutput`,
	provider_failed: `${K}.errors.providerFailed`,
	slug_taken: `${K}.errors.slugTaken`,
	invalid_slug: `${K}.errors.invalidSlug`,
	network: `${K}.errors.network`,
	unknown: `${K}.errors.unknown`,
};

/** Where a created draft opens. */
export function draftPath(
	result:
		| { kind: 'template'; templateId: string }
		| { kind: 'transactional'; transactionalEmailId: string }
		| { kind: 'campaign'; campaignId: string }
): string {
	switch (result.kind) {
		case 'template':
			return `/dashboard/send/emails/${result.templateId}/edit`;
		case 'transactional':
			return `/dashboard/send/transactional/${result.transactionalEmailId}/edit`;
		case 'campaign':
			// Setup next: the sender and the audience are the author's to choose.
			return `/dashboard/campaigns/new?id=${result.campaignId}&step=setup`;
	}
}
