const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const redis = require('redis');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const WebSocket = require('ws');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Redis
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});
redisClient.connect().catch(console.error);

// Auth Middleware
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.sendStatus(401);
  
  try {
    const user = jwt.verify(token, process.env.JWT_SECRET);
    req.user = user;
    next();
  } catch (err) {
    res.sendStatus(403);
  }
};

// Auth Routes
app.post('/api/auth/register', async (req, res) => {
  const { email, password, username } = req.body;
  
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (id, email, password, username, balance, created_at) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *',
      [uuidv4(), email, hashedPassword, username, 0]
    );
    
    const user = result.rows[0];
    const token = jwt.sign(
      { id: user.id, email: user.email, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    res.json({ token, user: { id: user.id, email: user.email, username: user.username, balance: user.balance } });
  } catch (err) {
    res.status(400).json({ error: 'Email or username already exists' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    
    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign(
      { id: user.id, email: user.email, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    res.json({ token, user: { id: user.id, email: user.email, username: user.username, balance: user.balance } });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// User Routes
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, username, balance, created_at FROM users WHERE id = $1', [req.user.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Market Data (Finnhub WebSocket proxy)
const clients = new Map();
const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, req) => {
  const symbols = req.url.split('?symbols=')[1]?.split(',') || ['AAPL'];
  
  const finnhubWs = new WebSocket(`wss://ws.finnhub.io?token=${process.env.FINNHUB_API_KEY}`);
  
  finnhubWs.on('open', () => {
    symbols.forEach(symbol => {
      finnhubWs.send(JSON.stringify({ type: 'subscribe', symbol }));
    });
  });
  
  finnhubWs.on('message', (data) => {
    ws.send(data);
  });
  
  ws.on('close', () => {
    finnhubWs.close();
  });
});

// Paper Trading Routes
app.post('/api/trade', authenticateToken, async (req, res) => {
  const { symbol, side, quantity, price } = req.body;
  
  try {
    const userResult = await pool.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    const balance = userResult.rows[0].balance;
    const total = quantity * price;
    
    if (side === 'buy' && balance < total) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    const tradeId = uuidv4();
    await pool.query(
      'INSERT INTO trades (id, user_id, symbol, side, quantity, price, total, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())',
      [tradeId, req.user.id, symbol, side, quantity, price, total]
    );
    
    // Update balance
    const newBalance = side === 'buy' ? balance - total : balance + total;
    await pool.query('UPDATE users SET balance = $1 WHERE id = $2', [newBalance, req.user.id]);
    
    // Update positions
    const positionResult = await pool.query(
      'SELECT * FROM positions WHERE user_id = $1 AND symbol = $2',
      [req.user.id, symbol]
    );
    
    if (positionResult.rows.length > 0) {
      const position = positionResult.rows[0];
      if (side === 'buy') {
        const newQuantity = parseFloat(position.quantity) + parseFloat(quantity);
        const newAvgPrice = ((parseFloat(position.quantity) * parseFloat(position.avg_price)) + total) / newQuantity;
        await pool.query(
          'UPDATE positions SET quantity = $1, avg_price = $2 WHERE id = $3',
          [newQuantity, newAvgPrice, position.id]
        );
      } else {
        const newQuantity = parseFloat(position.quantity) - parseFloat(quantity);
        if (newQuantity <= 0) {
          await pool.query('DELETE FROM positions WHERE id = $1', [position.id]);
        } else {
          await pool.query('UPDATE positions SET quantity = $1 WHERE id = $2', [newQuantity, position.id]);
        }
      }
    } else if (side === 'buy') {
      await pool.query(
        'INSERT INTO positions (id, user_id, symbol, quantity, avg_price, created_at) VALUES ($1, $2, $3, $4, $5, NOW())',
        [uuidv4(), req.user.id, symbol, quantity, price]
      );
    }
    
    res.json({ success: true, tradeId, newBalance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Trade failed' });
  }
});

app.get('/api/portfolio', authenticateToken, async (req, res) => {
  try {
    const positions = await pool.query('SELECT * FROM positions WHERE user_id = $1', [req.user.id]);
    const trades = await pool.query('SELECT * FROM trades WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
    
    res.json({
      positions: positions.rows,
      recentTrades: trades.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});
// Competition Routes
app.get('/api/competitions', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM competitions WHERE status = $1 ORDER BY start_date ASC',
      ['active']
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/competitions/join', authenticateToken, async (req, res) => {
  const { competitionId } = req.body;
  
  try {
    const compResult = await pool.query('SELECT * FROM competitions WHERE id = $1', [competitionId]);
    const competition = compResult.rows[0];
    
    if (!competition) return res.status(404).json({ error: 'Competition not found' });
    
    const userResult = await pool.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    if (userResult.rows[0].balance < competition.entry_fee) {
      return res.status(400).json({ error: 'Insufficient balance for entry fee' });
    }
    
    // Deduct entry fee
    await pool.query(
      'UPDATE users SET balance = balance - $1 WHERE id = $2',
      [competition.entry_fee, req.user.id]
    );
    
    // Add to competition
    await pool.query(
      'INSERT INTO competition_entries (id, user_id, competition_id, initial_balance, current_balance, joined_at) VALUES ($1, $2, $3, $4, $4, NOW())',
      [uuidv4(), req.user.id, competitionId, competition.starting_balance]
    );
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to join competition' });
  }
});

app.get('/api/competitions/leaderboard/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ce.*, u.username 
       FROM competition_entries ce 
       JOIN users u ON ce.user_id = u.id 
       WHERE ce.competition_id = $1 
       ORDER BY ce.current_balance DESC 
       LIMIT 100`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// NOWPayments Crypto Integration
app.post('/api/payments/create', authenticateToken, async (req, res) => {
  const { amount, currency = 'USD' } = req.body;
  
  try {
    const response = await axios.post('https://api.nowpayments.io/v1/payment', {
      price_amount: amount,
      price_currency: currency,
      pay_currency: 'BTC',
      ipn_callback_url: `${process.env.API_URL}/api/payments/webhook`,
      order_id: uuidv4(),
      order_description: 'NEXUS Trading Deposit'
    }, {
      headers: {
        'x-api-key': process.env.NOWPAYMENTS_API_KEY
      }
    });
    
    await pool.query(
      'INSERT INTO deposits (id, user_id, amount, currency, payment_id, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())',
      [uuidv4(), req.user.id, amount, currency, response.data.payment_id, 'pending']
    );
    
    res.json({
      paymentId: response.data.payment_id,
      payAddress: response.data.pay_address,
      payAmount: response.data.pay_amount,
      payCurrency: response.data.pay_currency
    });
  } catch (err) {
    res.status(500).json({ error: 'Payment creation failed' });
  }
});

app.post('/api/payments/webhook', async (req, res) => {
  const { payment_id, payment_status, order_id } = req.body;
  
  if (payment_status === 'finished') {
    const depositResult = await pool.query('SELECT * FROM deposits WHERE payment_id = $1', [payment_id]);
    if (depositResult.rows.length > 0) {
      const deposit = depositResult.rows[0];
      await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [deposit.amount, deposit.user_id]);
      await pool.query('UPDATE deposits SET status = $1 WHERE id = $2', ['completed', deposit.id]);
    }
  }
  
  res.sendStatus(200);
});

// Withdrawal
app.post('/api/withdraw', authenticateToken, async (req, res) => {
  const { amount, address, currency = 'BTC' } = req.body;
  
  try {
    const userResult = await pool.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    if (userResult.rows[0].balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    // Create withdrawal record
    await pool.query(
      'INSERT INTO withdrawals (id, user_id, amount, currency, address, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())',
      [uuidv4(), req.user.id, amount, currency, address, 'pending']
    );
    
    // Deduct balance
    await pool.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amount, req.user.id]);
    
    res.json({ success: true, message: 'Withdrawal request submitted' });
  } catch (err) {
    res.status(500).json({ error: 'Withdrawal failed' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Database initialization
const initDB = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        username VARCHAR(255) UNIQUE NOT NULL,
        balance DECIMAL(15,2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS trades (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES users(id),
        symbol VARCHAR(20) NOT NULL,
        side VARCHAR(10) NOT NULL,
        quantity DECIMAL(15,8) NOT NULL,
        price DECIMAL(15,2) NOT NULL,
        total DECIMAL(15,2) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS positions (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES users(id),
        symbol VARCHAR(20) NOT NULL,
        quantity DECIMAL(15,8) NOT NULL,
        avg_price DECIMAL(15,2) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS competitions (
        id UUID PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        entry_fee DECIMAL(15,2) NOT NULL,
        starting_balance DECIMAL(15,2) NOT NULL,
        prize_pool DECIMAL(15,2) NOT NULL,
        start_date TIMESTAMP NOT NULL,
        end_date TIMESTAMP NOT NULL,
        status VARCHAR(20) DEFAULT 'active'
      );
      
      CREATE TABLE IF NOT EXISTS competition_entries (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES users(id),
        competition_id UUID REFERENCES competitions(id),
        initial_balance DECIMAL(15,2) NOT NULL,
        current_balance DECIMAL(15,2) NOT NULL,
        joined_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS deposits (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES users(id),
        amount DECIMAL(15,2) NOT NULL,
        currency VARCHAR(10) NOT NULL,
        payment_id VARCHAR(255),
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS withdrawals (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES users(id),
        amount DECIMAL(15,2) NOT NULL,
        currency VARCHAR(10) NOT NULL,
        address VARCHAR(255) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('Database initialized');
  } finally {
    client.release();
  }
};

// Start server
const server = app.listen(PORT, () => {
  console.log(`NEXUS Server running on port ${PORT}`);
  initDB();
});

// WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});
      
