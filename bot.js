const { Bot } = require('grammy');
const { hydrate } = require('@grammyjs/hydrate');
const { Pool } = require('pg');

const { requireEnv } = require('./config/env');

const bot = new Bot(requireEnv('BOT_API_KEY'));
bot.use(hydrate());
const db = new Pool({ connectionString: requireEnv('DATABASE_URL') });

module.exports = { bot, db };
