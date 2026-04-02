import pg from 'pg';

const { Pool, types } = pg;

types.setTypeParser(20, (value) => Number(value));

const hasConnectionString = Boolean(process.env.DATABASE_URL);

const config = hasConnectionString
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.PGHOST || (process.platform === 'win32' ? '127.0.0.1' : '/var/run/postgresql'),
      port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
      user: process.env.PGUSER || process.env.USER,
      password: process.env.PGPASSWORD || undefined,
      database: process.env.PGDATABASE || 'smartai',
    };

export const pool = new Pool(config);

export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function withTransaction(callback) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}
