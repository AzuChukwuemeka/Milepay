import { Pool, PoolConfig, types } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// ─── Numeric type parsing ──────────────────────────────────────────────────────
// node-postgres returns NUMERIC/DECIMAL columns (used for all money columns:
// total_amount, amount_paid, overpayment_amount, milestones.amount, payments.amount)
// as JavaScript strings by default, to avoid silent precision loss on values that
// don't fit in a float. Every TS type in src/types/index.ts declares these fields
// as `number`, so without this parser they are silently wrong at runtime — string
// concatenation bugs (`+`) and `.toLocaleString()` calls (which resolve to
// String.prototype.toLocaleString and format nothing) go uncaught by the compiler.
// OID 1700 = numeric/decimal. Parse it as a float so runtime values actually match
// the declared types. (Multiply/divide already coerce strings fine; this closes
// the gap for `+`, `toLocaleString`, and JSON responses to the frontend.)
types.setTypeParser(1700, (value: string) => parseFloat(value));

const config: PoolConfig = {
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
};

export const pool = new Pool(config);

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
  process.exit(-1);
});

export const connectDB = async (): Promise<void> => {
  try {
    const client = await pool.connect();
    console.log('✅ PostgreSQL connected via Neon');
    client.release();
  } catch (error) {
    console.error('❌ PostgreSQL connection failed:', error);
    process.exit(1);
  }
};

export default pool;
