const pino = require('pino');
const pretty = require('pino-pretty');

const isProd = process.env.NODE_ENV === 'production';

// Важно: pino-pretty подключается напрямую как stream, а НЕ через
// `transport: { target: 'pino-pretty' }`. Транспорт запускается в отдельном
// воркер-треде (thread-stream), который падает под `node --watch` на Node 26
// («Error: this should not happen: undefined»).
const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'debug',
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  isProd
    ? undefined
    : pretty({
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      })
);

module.exports = { logger };
