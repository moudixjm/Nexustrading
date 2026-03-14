const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const migrations = [
  {
    name: 'create_users_table',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        username VARCHAR(255) UNIQUE NOT NULL,
        balance DECIMAL(15,2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    `
  },
  {
    name: 'create_trades_table',
    sql: `
      CREATE TABLE IF NOT EXISTS trades (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        symbol VARCHAR(20) NOT NULL,
        side VARCHAR(10) NOT NULL CHECK (side IN ('buy', 'sell')),
        quantity DECIMAL(15,8) NOT NULL,
        price DECIMAL(15,2) NOT NULL,
        total DECIMAL(15,2) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_trades_user_id ON trades(user_id);
      CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at);
    `
  },
  {
    name: 'create_positions_table',
    sql: `
      CREATE TABLE IF NOT EXISTS positions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        symbol VARCHAR(20) NOT NULL,
        quantity DECIMAL(15,8) NOT NULL,
        avg_price DECIMAL(15,2) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, symbol)
      );
      
      CREATE INDEX IF NOT EXISTS idx_positions_user_id ON positions(user_id);
    `
  },
  {
    name: 'create_competitions_table',
    sql: `
      CREATE TABLE IF NOT EXISTS competitions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        entry_fee DECIMAL(15,2) NOT NULL DEFAULT 0,
        starting_balance DECIMAL(15,2) NOT NULL DEFAULT 10000,
        prize_pool DECIMAL(15,2) NOT NULL DEFAULT 0,
        start_date TIMESTAMP NOT NULL,
        end_date TIMESTAMP NOT NULL,
        status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_competitions_status ON competitions(status);
      CREATE INDEX IF NOT EXISTS idx_competitions_dates ON competitions(start_date, end_date);
    `
  },
  {
    name: 'create_competition_entries_table',
    sql: `
      CREATE TABLE IF NOT EXISTS competition_entries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        competition_id UUID REFERENCES competitions(id) ON DELETE CASCADE,
        initial_balance DECIMAL(15,2) NOT NULL,
        current_balance DECIMAL(15,2) NOT NULL,
        final_rank INTEGER,
        prize_won DECIMAL(15,2) DEFAULT 0,
        joined_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, competition_id)
      );
      
      CREATE INDEX IF NOT EXISTS idx_competition_entries_competition_id ON competition_entries(competition_id);
      CREATE INDEX IF NOT EXISTS idx_competition_entries_user_id ON competition_entries(user_id);
    `
  },
  {
    name: 'create_deposits_table',
    sql: `
      CREATE TABLE IF NOT EXISTS deposits (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        amount DECIMAL(15,2) NOT NULL,
        currency VARCHAR(10) NOT NULL DEFAULT 'USD',
        payment_id VARCHAR(255),
        payment_method VARCHAR(50) DEFAULT 'crypto',
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
        created_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_deposits_user_id ON deposits(user_id);
      CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status);
    `
  },
  {
    name: 'create_withdrawals_table',
    sql: `
      CREATE TABLE IF NOT EXISTS withdrawals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        amount DECIMAL(15,2) NOT NULL,
        currency VARCHAR(10) NOT NULL DEFAULT 'USD',
        address VARCHAR(255) NOT NULL,
        network VARCHAR(50) DEFAULT 'BTC',
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
        created_at TIMESTAMP DEFAULT NOW(),
        processed_at TIMESTAMP,
        tx_hash VARCHAR(255)
      );
      
      CREATE INDEX IF NOT EXISTS idx_withdrawals_user_id ON withdrawals(user_id);
      CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
    `
  },
  {
    name: 'create_badges_table',
    sql: `
      CREATE TABLE IF NOT EXISTS badges (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        badge_type VARCHAR(50) NOT NULL,
        badge_name VARCHAR(100) NOT NULL,
        description TEXT,
        awarded_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_badges_user_id ON badges(user_id);
    `
  },
  {
    name: 'insert_sample_competitions',
    sql: `
      INSERT INTO competitions (name, description, entry_fee, starting_balance, prize_pool, start_date, end_date, status)
      SELECT 
        'Weekly Trading Championship',
        'Compete against top traders. 70% of entry fees go to prize pool!',
        10.00,
        10000.00,
        1000.00,
        NOW(),
        NOW() + INTERVAL '7 days',
        'active'
      WHERE NOT EXISTS (SELECT 1 FROM competitions WHERE name = 'Weekly Trading Championship');
      
      INSERT INTO competitions (name, description, entry_fee, starting_balance, prize_pool, start_date, end_date, status)
      SELECT 
        'Monthly Crypto Battle',
        'All crypto pairs allowed. High volatility, high rewards!',
        25.00,
        5000.00,
        5000.00,
        NOW(),
        NOW() + INTERVAL '30 days',
        'active'
      WHERE NOT EXISTS (SELECT 1 FROM competitions WHERE name = 'Monthly Crypto Battle');
      
      INSERT INTO competitions (name, description, entry_fee, starting_balance, prize_pool, start_date, end_date, status)
      SELECT 
        'Free Practice League',
        'No entry fee. Perfect for beginners to learn trading.',
        0.00,
        10000.00,
        100.00,
        NOW(),
        NOW() + INTERVAL '14 days',
        'active'
      WHERE NOT EXISTS (SELECT 1 FROM competitions WHERE name = 'Free Practice League');
    `
  }
];

const runMigrations = async () => {
  const client = await pool.connect();
  
  try {
    console.log('Running migrations...');
    
    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        executed_at TIMESTAMP DEFAULT NOW()
      );
    `);
    
    for (const migration of migrations) {
      const checkResult = await client.query(
        'SELECT 1 FROM migrations WHERE name = $1',
        [migration.name]
      );
      
      if (checkResult.rows.length === 0) {
        console.log(`Executing: ${migration.name}`);
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO migrations (name) VALUES ($1)',
          [migration.name]
        );
        console.log(`✓ ${migration.name} completed`);
      } else {
        console.log(`✓ ${migration.name} already executed`);
      }
    }
    
    console.log('\nAll migrations completed successfully!');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

runMigrations();
