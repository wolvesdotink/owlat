import type { OwlatConfig } from './types/config';
import { createHttpClient } from './utils/fetch';
import { ContactsResource } from './resources/contacts';
import { TransactionalResource } from './resources/transactional';
import { EventsResource } from './resources/events';
import { TopicsResource } from './resources/topics';

const DEFAULT_BASE_URL = 'https://api.owlat.app';
const DEFAULT_TIMEOUT = 30000;

/**
 * Owlat SDK client for interacting with the Owlat email marketing API.
 *
 * @example
 * ```typescript
 * import { Owlat } from '@owlat/sdk-js';
 *
 * // Initialize with API key
 * const owlat = new Owlat('lm_live_xxxxxxxx');
 *
 * // Or with full configuration
 * const owlat = new Owlat({
 *   apiKey: 'lm_live_xxxxxxxx',
 *   baseUrl: 'https://api.owlat.app',
 *   timeout: 30000,
 * });
 *
 * // Use resources
 * const contact = await owlat.contacts.create({ email: 'user@example.com' });
 * await owlat.transactional.send({ email: 'user@example.com', slug: 'welcome' });
 * await owlat.events.send({ email: 'user@example.com', eventName: 'signup' });
 * await owlat.topics.addContact({ topicId: 'topic_123', email: 'user@example.com' });
 * ```
 */
export class Owlat {
	/**
	 * Manage contacts in your audience.
	 */
	readonly contacts: ContactsResource;

	/**
	 * Send transactional emails.
	 */
	readonly transactional: TransactionalResource;

	/**
	 * Send events to trigger automations.
	 */
	readonly events: EventsResource;

	/**
	 * Manage topic memberships.
	 */
	readonly topics: TopicsResource;

	/**
	 * Create a new Owlat client.
	 *
	 * @param apiKeyOrConfig - API key string or full configuration object
	 */
	constructor(apiKeyOrConfig: string | OwlatConfig) {
		const config: OwlatConfig =
			typeof apiKeyOrConfig === 'string'
				? { apiKey: apiKeyOrConfig }
				: apiKeyOrConfig;

		const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
		const timeout = config.timeout ?? DEFAULT_TIMEOUT;

		const retryConfig = config.retry === false ? { maxRetries: 0 } : config.retry;
		const http = createHttpClient(config.apiKey, baseUrl, timeout, retryConfig);

		this.contacts = new ContactsResource(http);
		this.transactional = new TransactionalResource(http);
		this.events = new EventsResource(http);
		this.topics = new TopicsResource(http);
	}
}
