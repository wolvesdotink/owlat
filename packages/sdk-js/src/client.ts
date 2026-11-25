import type { OwlatConfig } from './types/config';
import { createHttpClient } from './utils/fetch';
import { ContactsResource } from './resources/contacts';
import { TransactionalResource } from './resources/transactional';
import { EventsResource } from './resources/events';
import { TopicsResource } from './resources/topics';
import { StatusResource } from './resources/status';
import { DomainsResource } from './resources/domains';
import { LimitsResource } from './resources/limits';
import { TransactionalEmailsResource } from './resources/transactionalEmails';
import { SavedBlocksResource } from './resources/savedBlocks';
import { RenderResource } from './resources/render';

/**
 * The hosted Owlat address. No self-hosted instance answers here, so a client
 * left on it sends its API key to a host its owner did not choose. Kept as the
 * default only so existing callers do not break in a patch release; the
 * constructor warns whenever it is used, and `baseUrl` becomes required.
 */
const DEFAULT_BASE_URL = 'https://api.owlat.app';
const DEFAULT_TIMEOUT = 30000;

const DEFAULT_BASE_URL_WARNING = `[@owlat/sdk-js] No baseUrl given, so requests and the API key go to ${DEFAULT_BASE_URL}, not to your instance. Pass baseUrl: your instance's API URL (Settings → API → API quickstart in the web app). baseUrl will become required.`;

/**
 * Owlat SDK client for interacting with the Owlat email marketing API.
 *
 * @example
 * ```typescript
 * import { Owlat } from '@owlat/sdk-js';
 *
 * // baseUrl is your instance's API URL (Settings → API → API quickstart in the web app)
 * const owlat = new Owlat({
 *   apiKey: 'lm_live_xxxxxxxx',
 *   baseUrl: 'https://rest.api.example.com',
 *   timeout: 30000,
 * });
 *
 * // Use resources
 * const contact = await owlat.contacts.create({ email: 'user@example.com' });
 * await owlat.transactional.send({ email: 'user@example.com', slug: 'welcome' });
 * await owlat.events.send({ email: 'user@example.com', eventName: 'signup' });
 * await owlat.topics.addContact({ topicId: 'topic_123', email: 'user@example.com' });
 * const { level, reasonCode } = await owlat.status.get();
 * const domains = await owlat.domains.list();
 * const { dailySends } = await owlat.limits.get();
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
	 * Read whether the instance can send, and why not.
	 */
	readonly status: StatusResource;

	/**
	 * Read the sending domains and the DNS records each needs.
	 */
	readonly domains: DomainsResource;

	/**
	 * Read the send limits that apply to this key, and what is left of them.
	 */
	readonly limits: LimitsResource;

	/**
	 * Read and write transactional emails, and publish them.
	 */
	readonly transactionalEmails: TransactionalEmailsResource;

	/**
	 * Read and write saved blocks.
	 */
	readonly savedBlocks: SavedBlocksResource;

	/**
	 * Render block content without storing it, as this instance would.
	 */
	readonly render: RenderResource;

	/**
	 * Create a client from an API key alone, which talks to the hosted address
	 * instead of your instance.
	 *
	 * @deprecated Pass `{ apiKey, baseUrl }` with your instance's API URL. This
	 * form sends the key to `https://api.owlat.app` and goes away when
	 * `baseUrl` becomes required.
	 */
	constructor(apiKey: string);
	/**
	 * Create a new Owlat client.
	 *
	 * @param config - API key, your instance's API URL, and optional settings
	 */
	constructor(config: OwlatConfig);
	/** Either form, for a caller holding a key or a config. */
	constructor(apiKeyOrConfig: string | OwlatConfig);
	constructor(apiKeyOrConfig: string | OwlatConfig) {
		const config: OwlatConfig =
			typeof apiKeyOrConfig === 'string' ? { apiKey: apiKeyOrConfig } : apiKeyOrConfig;

		// Same condition as the `??` fallback below, so an untyped caller's null warns too.
		if (config.baseUrl === undefined || config.baseUrl === null)
			console.warn(DEFAULT_BASE_URL_WARNING);
		const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
		const timeout = config.timeout ?? DEFAULT_TIMEOUT;

		const retryConfig = config.retry === false ? { maxRetries: 0 } : config.retry;
		const http = createHttpClient(config.apiKey, baseUrl, timeout, retryConfig);

		this.contacts = new ContactsResource(http);
		this.transactional = new TransactionalResource(http);
		this.events = new EventsResource(http);
		this.topics = new TopicsResource(http);
		this.status = new StatusResource(http);
		this.domains = new DomainsResource(http);
		this.limits = new LimitsResource(http);
		this.transactionalEmails = new TransactionalEmailsResource(http);
		this.savedBlocks = new SavedBlocksResource(http);
		this.render = new RenderResource(http);
	}
}
