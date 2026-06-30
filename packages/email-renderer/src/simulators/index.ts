/**
 * Client render simulators — public entry.
 *
 * Re-exports the registry primitives from ./registry and side-effect imports
 * every built-in simulator so that consumers importing from `./simulators`
 * receive a populated registry.
 */

// Side-effect imports: each module registers its simulator at load time.
// Order does not matter — lookups are keyed by client name.
import './gmail';
import './outlookDesktop';
import './outlookNew';
import './yahooMail';
import './appleMail';

export {
	simulateClient,
	registerClientSimulator,
	unregisterClientSimulator,
	clientSimulators,
} from './registry';
export type { ClientSimulator } from './registry';
