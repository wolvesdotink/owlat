import type { HttpClient } from '../utils/fetch';

/**
 * Base class for API resources.
 */
export abstract class BaseResource {
	protected readonly http: HttpClient;

	constructor(http: HttpClient) {
		this.http = http;
	}
}
