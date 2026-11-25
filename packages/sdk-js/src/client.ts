import type { OwlatConfig } from './types/config';
import { createHttpClient } from './utils/fetch';
import { normalizeBaseUrl } from './utils/baseUrl';
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
import { BrandKitResource } from './resources/brandKit';

const DEFAULT_TIMEOUT = 30000;

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
	 * Read and change the brand kit.
	 */
	readonly brandKit: BrandKitResource;

	/**
	 * Create a new Owlat client.
	 *
	 * @param config - API key, your instance's API URL, and optional settings
	 * @throws TypeError if `baseUrl` is missing or is not an absolute http(s) URL
	 */
	constructor(config: OwlatConfig) {
		// An untyped caller can still pass a bare key or nothing; neither has a
		// baseUrl, so both are refused with the message that says where to find it.
		const baseUrl = normalizeBaseUrl(config?.baseUrl);
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
		this.brandKit = new BrandKitResource(http);
	}
}
