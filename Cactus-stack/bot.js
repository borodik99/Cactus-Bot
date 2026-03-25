const { Bot } = require('grammy');
const { hydrate } = require('@grammyjs/hydrate');
const { Pool } = require('pg');

const bot = new Bot(process.env.BOT_API_KEY);
bot.use(hydrate());
const db = new Pool({ connectionString: process.env.DATABASE_URL });

module.exports = { bot, db };
