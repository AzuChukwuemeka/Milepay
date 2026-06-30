import { Pool, PoolConfig } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

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
