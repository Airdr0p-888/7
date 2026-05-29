// 钉钉 Webhook 代理 - 避免前端 CORS
const DING_WEBHOOK = 'https://oapi.dingtalk.com/robot/send?access_token=0aae4ea4b8f0426f91fe97181b97353763e8902795b4a4991d58b39996c5cbd7';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { wallet, token } = req.body;
  if (!wallet || !token) {
    res.status(400).json({ error: 'Missing wallet or token' });
    return;
  }

  const text = `mint 退款申请\n\n钱包地址: ${wallet}\n代币名称/合约: ${token}\n提交时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;

  try {
    const resp = await fetch(DING_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: text } })
    });
    const data = await resp.json();
    if (data.errcode === 0) {
      res.status(200).json({ success: true });
    } else {
      res.status(500).json({ error: data.errmsg || 'DingTalk error' });
    }
  } catch (e) {
    res.status(500).json({ error: 'Request failed' });
  }
};
