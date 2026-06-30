import { registerClientSimulator } from './registry';

// Apple Mail is the "gold standard" — full rendering, no changes.
registerClientSimulator('appleMail', (html) => html);
