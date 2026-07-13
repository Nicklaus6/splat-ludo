"use strict";
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  host:     process.env.PGHOST     || '127.0.0.1',
  port:     +(process.env.PGPORT   || 5432),
  user:     process.env.PGUSER     || 'splat_user',
  password: process.env.PGPASSWORD || '',
  database: process.env.PGDATABASE || 'splat_ludo',
  max: 8,
});

async function query(text, params) {
  const r = await pool.query(text, params);
  return r;
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

// convenience: fetch one row or null
async function one(text, params) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}

module.exports = { pool, query, one, migrate };
