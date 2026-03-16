const { Bot } = require('grammy');
const { Pool } = require('pg');

const bot = new Bot(process.env.BOT_API_KEY);
const db = new Pool({ connectionString: process.env.DATABASE_URL });

module.exports = { bot, db };
