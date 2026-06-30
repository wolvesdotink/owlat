import { inject, provide, type InjectionKey } from 'vue';
import type { EmailBuilderHandlers } from '../types';

/**
 * Injection key for email builder handlers
 */
export const EmailBuilderHandlersKey: InjectionKey<EmailBuilderHandlers> =
	Symbol('email-builder-handlers');

/**
 * Provide email builder handlers to descendant components
 */
export function provideEmailBuilderHandlers(handlers: EmailBuilderHandlers): void {
	provide(EmailBuilderHandlersKey, handlers);
}

/**
 * Inject email builder handlers from an ancestor component
 * @throws Error if handlers are not provided
 */
export function useEmailBuilderHandlers(): EmailBuilderHandlers {
	const handlers = inject(EmailBuilderHandlersKey);
	if (!handlers) {
		throw new Error(
			'EmailBuilder handlers not provided. Call provideEmailBuilderHandlers() in a parent component.'
		);
	}
	return handlers;
}
