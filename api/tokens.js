const { Redis } = require('@upstash/redis');

// 管理员钱包地址（有删除权限）
const ADMIN_WALLET = '0xF11fF8Db8DC0bd36B82154Af94A9f77d53fee8ee';
// 部署者钱包（过滤代币列表用）
const DEPLOYER_WALLET = '0x2aF55B34E616dCe99230fC8C694a6E6fFdF79e5b';

// Redis key
const REDIS_KEY = 'tokens_data';

// 初始化 Redis（通过 Vercel Upstash 集成自动注入环境变量）
// Upstash 注入的是 KV_REST_API_URL + KV_REST_API_TOKEN
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Wallet');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    if (req.method === 'GET') {
      return await listTokens(req, res);
    } else if (req.method === 'POST') {
      return await addToken(req, res);
    } else if (req.method === 'DELETE') {
      return await deleteToken(req, res);
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (e) {
    console.error('API Error:', e);
    return res.status(500).json({ error: e.message });
  }
};

// GET /api/tokens
async function listTokens(req, res) {
  let tokens = await redis.get(REDIS_KEY);
  if (!tokens) tokens = [];
  // 返回所有代币（不再按钱包过滤）
  return res.status(200).json(tokens);
}

// POST /api/tokens
async function addToken(req, res) {
  var token = req.body;
  if (!token || !token.a || !token.n) {
    return res.status(400).json({ error: 'Missing required fields: a, n' });
  }

  var tokens = await redis.get(REDIS_KEY);
  if (!tokens) tokens = [];

  // 去重
  var exists = tokens.some(function(t) { return t.a === token.a; });
  if (!exists) {
    tokens.push(token);
  }

  await redis.set(REDIS_KEY, tokens);
  return res.status(200).json({ ok: true, count: tokens.length });
}

// DELETE /api/tokens
async function deleteToken(req, res) {
  var adminWallet = req.headers['x-admin-wallet'] || (req.body && req.body.admin);
  if (!adminWallet || adminWallet.toLowerCase() !== ADMIN_WALLET.toLowerCase()) {
    return res.status(403).json({ error: 'Admin only' });
  }

  var contractAddr = req.body.a;
  if (!contractAddr) {
    return res.status(400).json({ error: 'Missing contract address (a)' });
  }

  var tokens = await redis.get(REDIS_KEY);
  if (!tokens) tokens = [];

  var before = tokens.length;
  tokens = tokens.filter(function(t) { return t.a !== contractAddr; });

  if (tokens.length === before) {
    return res.status(404).json({ error: 'Token not found' });
  }

  await redis.set(REDIS_KEY, tokens);
  return res.status(200).json({ ok: true, count: tokens.length });
}
