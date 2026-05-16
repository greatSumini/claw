export * from './types.js';
export { routeMessage, routeMessage as routeDiscord } from './router.js';
export { classifyMail } from './importance.js';
export {
  buildRepoWorkSystemAppend,
  buildClawMaintenanceSystemAppend,
  buildWikiIngestSystemAppend,
  CLAW_RESTART_MARKER,
} from './prompt.js';
export type { RepoWorkPromptArgs, ClawMaintenancePromptArgs, WikiIngestPromptArgs } from './prompt.js';
