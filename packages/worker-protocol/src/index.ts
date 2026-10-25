/**
 * The Convex <-> worker wire contract. Subpaths: `/imap` and `/mailSync` (the
 * endpoint registries), `/fields` (the field vocabulary shared with the mail
 * tables), `/client` (worker references and the checked client),
 * `/validatorMatch`, `/decodeJson` (request-body decoding for every HTTP
 * ingress; import it by subpath so a transport does not pull in the endpoint
 * registries), and the test-only `/wireFixtures`.
 */

export {
	defineEndpoint,
	type AnyWorkerEndpoint,
	type EndpointArgs,
	type EndpointKind,
	type EndpointResult,
	type EndpointReturns,
	type Wire,
	type WorkerEndpoint,
} from './contract';
export { IMAP_ENDPOINTS } from './imap/index';
export { MAIL_SYNC_ENDPOINTS } from './mailSync/index';
export { matchesValidator, validatorMismatch, type MatchOptions } from './validatorMatch';
