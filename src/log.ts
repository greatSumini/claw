import pino from 'pino';
import path from 'node:path';
import fs from 'node:fs';

const logsDir = process.env.LOGS_DIR || path.resolve(process.cwd(), 'logs');
fs.mkdirSync(logsDir, { recursive: true });

const transport = pino.transport({
  targets: [
    {
      target: 'pino-pretty',
      level: 'info',
      options: { colorize: true, singleLine: true, ignore: 'pid,hostname' },
    },
    {
      target: 'pino/file',
      level: 'debug',
      options: { destination: path.join(logsDir, 'claw.log'), mkdir: true },
    },
    {
      target: 'pino/file',
      level: 'error',
      options: { destination: path.join(logsDir, 'claw.error.log'), mkdir: true },
    },
  ],
});

export const log = pino({ level: 'debug' }, transport);

export type Logger = typeof log;
