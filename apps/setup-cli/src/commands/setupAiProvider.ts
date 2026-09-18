/**
 * Terminal-wizard pickers for the AI planes.
 *
 * Owlat runs three decoupled AI planes and this file asks about two of them.
 * The LANGUAGE plane is everything that writes — drafts, replies, summaries,
 * the assistant — and it is the one question an install with `ai` on has always
 * been asked. The DECISION plane answers the yes/no, category and score
 * judgements those features make (ADR-0060) and is entirely optional; the
 * EMBEDDING plane is local by default and needs nothing from an operator here.
 *
 * Extracted from `setup.ts` for the same reason `setupSendingProvider.ts` was:
 * that file stays a readable list of steps, and under the size ratchet.
 */

import { select, password, text, group, isCancel, log } from '@clack/prompts';
import { validateWithSpinner } from '../lib/progress';
import { type EnvMap } from '../lib/env';
import { SETUP_DEFAULT_DECISION_KIND } from '../lib/setupEnvDefaults';
import { validateOpenAIKey, validateOpenRouterKey } from '../lib/validators';

export async function pickAIProvider(): Promise<EnvMap | null> {
	const provider = await select({
		message: 'AI provider',
		options: [
			{ label: 'OpenRouter (200+ models, recommended)', value: 'openrouter' },
			{ label: 'OpenAI', value: 'openai' },
			{ label: 'Ollama (local — bundled ollama service, no API key)', value: 'ollama' },
			{ label: 'Custom (Anthropic, Together, Groq, local LM Studio…)', value: 'custom' },
		],
	});
	if (isCancel(provider)) return null;

	if (provider === 'openrouter') {
		const apiKey = await password({ message: 'OpenRouter API key (sk-or-...)' });
		if (isCancel(apiKey)) return null;
		if (
			!(await validateWithSpinner('Validating OpenRouter key', () =>
				validateOpenRouterKey(apiKey as string)
			))
		) {
			return null;
		}
		return {
			LLM_PROVIDER: 'openrouter',
			LLM_API_KEY: apiKey as string,
			OPENROUTER_API_KEY: apiKey as string,
		};
	}

	if (provider === 'openai') {
		const apiKey = await password({ message: 'OpenAI API key (sk-...)' });
		if (isCancel(apiKey)) return null;
		if (
			!(await validateWithSpinner('Validating OpenAI key', () =>
				validateOpenAIKey(apiKey as string)
			))
		) {
			return null;
		}
		return {
			LLM_PROVIDER: 'openai',
			LLM_API_KEY: apiKey as string,
			OPENAI_API_KEY: apiKey as string,
		};
	}

	if (provider === 'ollama') {
		// Local model server — no key, no remote validation. The provider factory
		// resolves http://ollama:11434/v1 automatically when LLM_PROVIDER=ollama.
		// The bundled `ollama` service comes up under the same profile as the AI
		// worker; pull a model into it after boot (e.g. `docker compose exec ollama
		// ollama pull llama3.1`) and set LLM_MODEL_* to match.
		log.info(
			'Ollama runs locally on the internal Docker network (ollama:11434). No API key needed.\n' +
				'After the stack is up, pull a model into it, e.g.: docker compose exec ollama ollama pull llama3.1'
		);
		return {
			LLM_PROVIDER: 'ollama',
		};
	}

	if (provider === 'custom') {
		const result = await group({
			baseUrl: () =>
				text({
					message: 'OpenAI-compatible base URL',
					placeholder: 'https://api.anthropic.com/v1',
				}),
			apiKey: () => password({ message: 'API key' }),
			fast: () => text({ message: 'Fast model name', placeholder: 'claude-3-5-haiku' }),
			capable: () => text({ message: 'Capable model name', placeholder: 'claude-3-5-sonnet' }),
		});
		return {
			LLM_PROVIDER: 'custom',
			LLM_BASE_URL: result.baseUrl,
			LLM_API_KEY: result.apiKey,
			LLM_MODEL_FAST: result.fast,
			LLM_MODEL_CAPABLE: result.capable,
		};
	}

	return null;
}

/** What the decision question produced: the env to write, and whether it opted in. */
export interface DecisionProviderChoice {
	readonly env: EnvMap;
	/** True only when a decision provider was actually configured. */
	readonly isPlaneConfigured: boolean;
}

/**
 * The decision plane — a third AI plane, asked once and skipped by default.
 *
 * A decision provider answers the yes/no, category and score judgements the AI
 * features make and returns a calibrated probability instead of a text model's
 * self-report (ADR-0060). It is an ADDITION: everything that writes — drafts,
 * replies, summaries, the assistant — stays on the provider chosen above.
 *
 * The recommendation is pre-filled and skipping is one keystroke. Those are two
 * different defaults and the plan keeps them apart on purpose:
 * {@link SETUP_DEFAULT_DECISION_KIND} is what a brand-new install is OFFERED,
 * while the backend's `DEFAULT_DECISION_KIND` ('llm') is what any install that
 * never opted in RESOLVES to. Skip stays the first option in the list, so the
 * answer that changes nothing is always the one on top; taking it leaves the
 * deployment answering every judgement on the language model above, which is
 * exactly what an install that never saw this prompt does.
 *
 * In a self-hosted deployment the operator is the data controller and a decision
 * vendor would be their processor, not ours — so choosing the recommendation
 * still costs a key of their own and a consent screen that names what leaves.
 *
 * An empty key is read as a skip rather than written to `.env`. A bare Enter on
 * a password prompt is the reachable path to a credential that exists, fails
 * every call, and reads as a provider outage.
 */
export async function pickDecisionProvider(): Promise<DecisionProviderChoice | null> {
	const skipped: DecisionProviderChoice = { env: {}, isPlaneConfigured: false };

	const provider = await select({
		message: 'Decision provider (optional — answers yes/no, category and score judgements)',
		options: [
			{
				label: 'Skip — every judgement stays on the language model above',
				value: 'skip',
			},
			{
				label: 'TypeSafe (Jev)',
				value: 'typesafe',
				hint: 'recommended; your own key, and message text leaves the deployment',
			},
		],
		initialValue: SETUP_DEFAULT_DECISION_KIND,
	});
	if (isCancel(provider)) return null;
	if (provider !== 'typesafe') return skipped;

	log.info(
		'Each judgement sends its state — message text reduced to visible words, quoted history,\n' +
			'signatures and attachments removed — to https://api.typesafe.ai under YOUR key.\n' +
			'You are the data controller and TypeSafe would be your processor; the full data-flow\n' +
			'note is in the docs under Developer → Providers. Turning the `ai.decisionPlane` flag\n' +
			'off puts every judgement back on your language model, with no redeploy.'
	);

	const apiKey = await password({ message: 'TypeSafe API key' });
	if (isCancel(apiKey)) return null;
	if (!(apiKey as string)) {
		log.warn('No key entered — leaving every judgement on the language model.');
		return skipped;
	}

	return {
		env: { DECISION_PROVIDER: 'typesafe', TYPESAFE_API_KEY: apiKey as string },
		isPlaneConfigured: true,
	};
}
