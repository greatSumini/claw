import { loadConfig } from '../config.js';
import { getDb } from './db.js';
import { log } from '../log.js';

const cfg = loadConfig();
log.info({ dbFile: cfg.paths.dbFile }, 'Running migrations');
const db = getDb(cfg.paths.dbFile);
log.info('Migrations applied');
db.close();
