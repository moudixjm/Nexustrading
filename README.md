# NEXUS Trading Platform

Paper trading platform with real-time market data, competitions, and crypto payments.

## Stack

- **Backend**: Node.js, Express, PostgreSQL, Redis
- **Frontend**: Vanilla JS SPA (single HTML file)
- **Market Data**: Finnhub WebSocket (free tier: 50 symbols)
- **Trading**: Alpaca Paper Trading API (free, 200 calls/min)
- **Payments**: NOWPayments (crypto, no KYC), Stripe (fiat)

## Quick Start

```bash
# Install
npm install

# Setup DB (PostgreSQL + Redis required)
npm run migrate

# Dev server
npm run dev

## Environment Variables

```env
PORT=3000
NODE_ENV=development

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/nexus
REDIS_URL=redis://localhost:6379

# Auth
JWT_SECRET=your_jwt_secret_here

# Alpaca Paper Trading
ALPACA_API_KEY=your_alpaca_key
ALPACA_SECRET_KEY=your_alpaca_secret

# Finnhub (free tier)
FINNHUB_API_KEY=your_finnhub_key

# NOWPayments (crypto)
NOWPAYMENTS_API_KEY=your_nowpayments_key

# Stripe (fiat)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
Endpoint	Method	Auth	Description	
`/api/auth/register`	POST	No	Create account	
`/api/auth/login`	POST	No	Login, get JWT	
`/api/portfolio`	GET	Yes	Get positions & trades	
`/api/trade`	POST	Yes	Execute paper trade	
`/api/competitions`	GET	No	List competitions	
`/api/competitions/join`	POST	Yes	Join competition	
`/api/payments/create`	POST	Yes	Create crypto deposit	
`/api/withdraw`	POST	Yes	Request withdrawal

## Deployment

### Railway (Backend)
1. Push to GitHub
2. Connect Railway to repo
3. Add environment variables
4. Deploy

### Netlify (Frontend)
1. Drag `public/` folder to Netlify drop
2. Or connect GitHub with build command: `echo "No build needed"`

## WebSocket Events

Client receives real-time price updates:
```javascript
{ type: 'PRICE_UPDATE', symbol: 'AAPL', price: 150.25 }
