/* V4 雪花铸造页
 * 铸造逻辑：V4 合约通过 receive() 收原生 BNB 铸造，每次必须精确发送 Mint_Once_BNB。
 * 钱包：优先使用 window.ethereum（币安钱包插件 / 币安 App 内置浏览器 / MetaMask 等皆注入它）。
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const BSC_CHAIN_ID = 56;
  // 只读 RPC（按可用性排序；币安种子节点在本环境会超时，优先用 publicnode）
  const READ_RPCS = [
    "https://bsc.publicnode.com",
    "https://rpc.ankr.com/bsc",
    "https://bsc-dataseed.binance.org/",
  ];
  const EXPLORER = "https://bscscan.com";

  let provider = null;     // 浏览器钱包 provider（已连接）
  let readProvider = null; // 只读 provider（未连钱包时也能读链上数据）
  let signer = null;
  let currentAccount = null;
  let contractAddr = "";
  let tokenContract = null;
  let meta = {
    name: "", symbol: "", decimals: 18,
    price: 0n, max: 0n, mintAll: 0n, requiredNFT: ethers.ZeroAddress,
    maxMint: 0n, start: 0n,
  };

  const shortAddr = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
  function readProv() {
    if (provider) return provider;
    if (!readProvider) {
      readProvider = new ethers.JsonRpcProvider(
        READ_RPCS[0],
        { chainId: 56, name: "bnb" },
        { staticNetwork: true, timeout: 20000 }
      );
    }
    return readProvider;
  }

  /* ---------- 提示 ---------- */
  let toastTimer = null;
  function showMsg(text, kind) {
    const el = $("mintStatus");
    if (el) {
      el.textContent = text;
      el.className = "status" + (kind ? " " + kind : "");
    }
    const t = $("toast");
    if (t) {
      t.textContent = text;
      t.classList.add("show");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
    }
  }

  /* ---------- 熊猫马赛克漂浮背景（方块瓦片） ---------- */
  function initPandaBg() {
    const cv = $("pandaBg");
    if (!cv) return;
    const ctx = cv.getContext("2d");
    let w, h, tiles;
    const colors = ["#7ee08f", "#c9ffb8", "#ffffff", "#ff9ec4", "#1b1b1b"];
    function resize() {
      w = cv.width = window.innerWidth;
      h = cv.height = window.innerHeight;
      const n = Math.min(46, Math.floor(w / 22));
      tiles = Array.from({ length: n }, () => ({
        x: Math.random() * w, y: Math.random() * h,
        s: 12 + Math.random() * 30,
        sp: 0.2 + Math.random() * 0.7,
        dx: (Math.random() - 0.5) * 0.5,
        a: 0.10 + Math.random() * 0.18,
        c: colors[Math.floor(Math.random() * colors.length)],
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.012,
      }));
    }
    function draw() {
      ctx.clearRect(0, 0, w, h);
      for (const t of tiles) {
        t.y += t.sp; t.x += t.dx; t.rot += t.vr;
        if (t.y > h + 40) { t.y = -40; t.x = Math.random() * w; }
        if (t.x > w + 40) t.x = -40;
        if (t.x < -40) t.x = w + 40;
        ctx.save();
        ctx.globalAlpha = t.a;
        ctx.translate(t.x, t.y);
        ctx.rotate(t.rot);
        ctx.fillStyle = t.c;
        ctx.fillRect(-t.s / 2, -t.s / 2, t.s, t.s);
        ctx.strokeStyle = "rgba(0,0,0,0.18)";
        ctx.lineWidth = 1;
        ctx.strokeRect(-t.s / 2, -t.s / 2, t.s, t.s);
        ctx.restore();
      }
      requestAnimationFrame(draw);
    }
    resize();
    window.addEventListener("resize", resize);
    draw();
  }

  /* ---------- 网络 ---------- */
  async function ensureNetwork() {
    const eth = window.ethereum || window.BinanceChain;
    if (!eth) return;
    try {
      const cid = await eth.request({ method: "eth_chainId" });
      if (Number(cid) !== BSC_CHAIN_ID) {
        try {
          await eth.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x38" }],
          });
        } catch (_) { /* 用户拒绝或不支持，忽略 */ }
      }
    } catch (_) { /* 忽略 */ }
  }

  /* ---------- 连接钱包（扫码优先：Agentic Wallet / WalletConnect） ---------- */
  const WC_PID_KEY = "panda_wc_pid";
  const DEFAULT_WC_PID = "d1d20d01deca8b04d0c243954db38bd8"; // 11.3 同款默认 projectId
  const AGENTIC_RELAY = READ_RPCS; // 复用只读节点，供 Agentic 路由的 eth_call 等读取

  function wcProjectId() {
    return (localStorage.getItem(WC_PID_KEY) || DEFAULT_WC_PID).trim();
  }
  function agentApiUrl() {
    return (document.querySelector('meta[name="agent-wallet-api"]')?.content || "").trim().replace(/\/$/, "");
  }
  async function agentCall(action, extra = {}) {
    const r = await fetch(agentApiUrl(), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, sessionId: agenticSession, ...extra }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(j.error || "Agentic Wallet 请求失败");
    return j;
  }
  function nested(obj, keys) {
    if (!obj || typeof obj !== "object") return null;
    for (const key of keys) if (typeof obj[key] === "string" && obj[key]) return obj[key];
    for (const value of Object.values(obj)) { const f = nested(value, keys); if (f) return f; }
    return null;
  }
  function saveAgenticLogin(o) { try { localStorage.setItem("agentic_login", JSON.stringify(o)); } catch {} }
  function clearAgenticLogin() { try { localStorage.removeItem("agentic_login"); } catch {} }
  function readAgenticLogin() { try { return JSON.parse(localStorage.getItem("agentic_login")); } catch { return null; } }

  async function rpcCall(method, params) {
    let lastMsg = "", lastData = "";
    for (const rpc of AGENTIC_RELAY) {
      try {
        const response = await fetch(rpc, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        const json = await response.json();
        if (!json.error) return json.result;
        lastMsg = (json.error && json.error.message) || "";
        lastData = typeof (json.error && json.error.data) === "string" ? json.error.data : "";
        if (lastData) break;
      } catch (e) { lastMsg = String((e && e.message) || e); }
    }
    if (lastData) throw new Error("合约拒绝: " + lastData);
    if (/revert/i.test(lastMsg)) throw new Error("合约拒绝: " + lastMsg);
    throw new Error(method + " 请求失败: 公共节点不可用");
  }

  // EIP-6963 + 币安插件识别（只认币安钱包，避免误连 MetaMask）
  const eip6963 = [];
  window.addEventListener("eip6963:announceProvider", (e) => {
    if (e && e.detail && e.detail.info && e.detail.provider) eip6963.push(e.detail);
  });
  function inBinanceApp() {
    return /Binance|binancew3w|bnbweb3/i.test(navigator.userAgent) || !!(window.binancew3w);
  }
  function injectedWallet() {
    const binance = eip6963.filter((d) => String((d.info && d.info.rdns) || "").toLowerCase().includes("binance"));
    if (binance.length) return binance[0].provider;
    const e = window.ethereum;
    if (e && (e.isBinance || e.isBinanceWeb3Wallet || e.isBinanceW3W)) return e;
    if (window.BinanceChain) return window.BinanceChain;
    if (window.binancew3w && window.binancew3w.ethereum) return window.binancew3w.ethereum;
    if (inBinanceApp() && e) return e; // 币安 App 内置浏览器没打标记时的兜底
    return null;
  }

  let agenticSession = "";
  let qrAborted = false;
  let wcProvider = null;
  let agenticProvider = null;

  // Agentic 路由的签名器：把 eth_sendTransaction 转发给币安 Agentic 后端预览+执行
  function buildAgenticProvider(address) {
    const toHex = (v) =>
      typeof v === "bigint" ? "0x" + v.toString(16)
      : v == null ? "0x"
      : typeof v === "number" ? "0x" + v.toString(16)
      : String(v);
    return {
      async request({ method, params = [] }) {
        if (method === "eth_chainId") return "0x38";
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [address];
        if (["eth_blockNumber", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_call", "eth_getBalance"].includes(method))
          return rpcCall(method, params);
        if (method === "eth_sendTransaction") {
          const tx = params[0];
          const preview = await agentCall("preview", {
            tx: { from: address, to: tx.to, value: tx.value ? toHex(tx.value) : "0x0", inputData: tx.data || "0x" },
          });
          const requestId = nested(preview.result, ["requestId"]);
          if (!requestId) throw new Error("交易预览未返回 requestId");
          const executed = await agentCall("execute", { requestId });
          const hash = nested(executed.result, ["txHash", "transactionHash", "hash"]);
          if (!hash) throw new Error("等待币安 App 确认交易");
          return hash;
        }
        if (method.startsWith("eth_")) return rpcCall(method, params);
        if (method.startsWith("wallet_")) return null; // 权限类查询，Agentic 不支持，返回空避免报错
        throw new Error("不支持的钱包方法: " + method);
      },
    };
  }

  // 把连接结果接入本页 provider/signer（铸造 / 查询通用）
  async function applyConnected(walletProv, address) {
    provider = new ethers.BrowserProvider(walletProv);
    signer = await provider.getSigner();
    currentAccount = address;
    $("connectBtn").textContent = shortAddr(address);
    $("topWallet").textContent = shortAddr(address);
    onAccountChanged(address);
    await ensureNetwork();
    if (contractAddr) loadInfo();
    showMsg("钱包已连接：" + address, "ok");
  }

  // 扫码是唯一默认入口：点「连接币安 AI 钱包」直接弹二维码
  // 站点域名已加入 Agentic 后端 Origin 白名单，优先走 Agentic Wallet 扫码；
  // 若后端偶发不可用，自动退化 WalletConnect 扫码（兜底）。
  function connect() {
    connectAgenticRoute();
  }

  async function connectBrowserWallet() {
    const w = injectedWallet() || (eip6963[0] && eip6963[0].provider) || window.ethereum;
    if (!w) {
      showMsg("未检测到浏览器钱包（币安 / TP / MetaMask 等）。请改用「Agentic Wallet 扫码」连接。", "err");
      return;
    }
    try {
      const accs = await w.request({ method: "eth_requestAccounts" });
      await applyConnected(w, accs[0]);
    } catch (e) { showMsg("连接失败：" + (e.message || e), "err"); }
  }

  // 默认且优先的扫码路线：有 Agentic API 先走 Agentic，失败则退化成 WalletConnect 扫码
  async function connectAgenticRoute() {
    if (agentApiUrl()) {
      try { await connectAgentic(); return; }
      catch (e) { showMsg("Agentic 服务不可用，改用 WalletConnect 扫码…", ""); }
    }
    await connectWC();
  }

  async function connectAgentic() {
    try {
      qrAborted = false;
      showMsg("正在获取币安 Agentic Wallet 登录二维码…");
      const login = await agentCall("login");
      agenticSession = login.sessionId;
      const data = login.result || {};
      const url = nested(data, ["urlForWeb", "qrCodeUrl"]);
      const qrCodeId = nested(data, ["qrCodeId"]);
      const pair = nested(data, ["pairingCode"]);
      if (!url || !qrCodeId) throw new Error("未收到币安登录二维码");
      saveAgenticLogin({ sessionId: agenticSession, qrCodeId, url, pair });
      showAgenticQr({ url, pair });
      await waitAgenticConfirm(qrCodeId);
    } catch (e) {
      clearAgenticLogin(); closeQr();
      const msg = (e && e.message) || String(e);
      if (/load failed|failed to fetch|networkerror|network error/i.test(msg))
        showMsg("Agentic 服务当前环境无法访问，请改用 WalletConnect 扫码或浏览器钱包。", "err");
      else showMsg("Agentic Wallet 连接失败：" + msg, "err");
      throw e;
    }
  }

  async function waitAgenticConfirm(qrCodeId) {
    await agentCall("confirm", { qrCodeId });
    if (qrAborted) throw new Error("已取消登录");
    const wallet = await agentCall("wallet");
    const address = wallet.address;
    agenticProvider = buildAgenticProvider(address);
    closeQr();
    await applyConnected(agenticProvider, address);
  }

  function showAgenticQr({ url, pair }) {
    const box = $("qrBox");
    if (box) box.innerHTML = window.WCMint?.qrSvg ? window.WCMint.qrSvg(url) : url;
    if ($("qrMode")) $("qrMode").textContent = "用币安 App 扫码，核对配对码后确认登录。";
    if ($("awPair")) $("awPair").textContent = pair || "——";
    if ($("wcOpen")) { $("wcOpen").href = url; $("wcOpen").textContent = "打开币安登录"; }
    if ($("qrModal")) $("qrModal").classList.remove("hidden");
    if ($("awWait")) $("awWait").textContent = "等待币安 App 扫码并确认…";
  }

  // 手机从币安 App 返回后（即使标签页被重载）自动恢复登录态
  async function restoreAgenticSession() {
    if (!agentApiUrl() || provider || currentAccount) return;
    const saved = readAgenticLogin();
    if (!saved || !saved.sessionId || !saved.qrCodeId) return;
    agenticSession = saved.sessionId;
    showAgenticQr(saved);
    try { await waitAgenticConfirm(saved.qrCodeId); }
    catch (e) { if (!qrAborted) clearAgenticLogin(); closeQr(); showMsg("上次登录会话已失效，请重新点击「连接钱包」。", "err"); }
  }

  function wcOpenUrl(uri) { return "https://walletconnect.com/wc?uri=" + encodeURIComponent(uri); }
  function showQr(uri) {
    const ok = typeof uri === "string" && uri.indexOf("wc:") === 0;
    const box = $("qrBox");
    if (box) {
      if (ok && window.WCMint && window.WCMint.qrSvg) { try { box.innerHTML = window.WCMint.qrSvg(uri); } catch { box.textContent = uri; } }
      else box.innerHTML = `<span style="color:#ff8a8a">连接串异常（不是有效的 wc: 连接串）：<br>${String(uri).slice(0, 300)}</span>`;
    }
    if ($("wcOpen")) { $("wcOpen").href = ok ? wcOpenUrl(uri) : "#"; $("wcOpen").textContent = "打开币安 App"; }
    if ($("qrMode")) $("qrMode").textContent = ok ? "用币安 App 扫码，确认配对码一致后授权连接。" : "连接串异常";
    if ($("qrModal")) $("qrModal").classList.remove("hidden");
    const tm = ok ? uri.match(/^wc:([0-9a-fA-F]+)@/) : null;
    if ($("awPair")) $("awPair").textContent = tm ? tm[1].slice(0, 6).toUpperCase() : "——";
    if ($("awBadge")) { $("awBadge").textContent = "正在连接…"; $("awBadge").classList.remove("ok"); }
    startWaitTimer();
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) && String(uri).startsWith("wc:")) {
      try { window.open(wcOpenUrl(uri), "_blank"); } catch {}
    }
  }
  function showUrlQr() {
    const url = location.href.split("#")[0];
    const box = $("qrBox");
    if (box) { try { box.innerHTML = window.WCMint && window.WCMint.qrSvg ? window.WCMint.qrSvg(url) : url; } catch { box.textContent = url; } }
    if ($("qrMode")) $("qrMode").textContent = "用币安 App 扫码 → 在 App 内打开本站 → App 内自带币安钱包，无需扫码连接。";
    if ($("awPair")) $("awPair").textContent = "——";
    if ($("wcOpen")) { $("wcOpen").href = url; $("wcOpen").textContent = "打开本站"; }
    if ($("qrModal")) $("qrModal").classList.remove("hidden");
    if ($("awBadge")) { $("awBadge").textContent = "正在连接…"; $("awBadge").classList.remove("ok"); }
    startWaitTimer();
  }
  let waitTimer = null, waitStart = 0;
  function startWaitTimer() {
    stopWaitTimer(); waitStart = Date.now();
    const el = $("awWait"); if (!el) return;
    const tick = () => { el.textContent = `等待币安 App 确认 · ${Math.floor((Date.now() - waitStart) / 1000)}s`; };
    tick(); waitTimer = setInterval(tick, 1000);
  }
  function stopWaitTimer() {
    if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
    const el = $("awWait"); if (el) el.textContent = "";
  }
  function closeQr() { qrAborted = true; const m = $("qrModal"); if (m) m.classList.add("hidden"); stopWaitTimer(); }

  // WalletConnect 扫码连币安 App（无 Agentic API 或其后端不可用时的兜底）
  async function connectWC() {
    const W = window.WCMint;
    if (W && W.EthereumProvider) {
      const pid = wcProjectId();
      if (!pid) { showUrlQr(); showMsg("未配置 WalletConnect projectId，已改用网址码在币安 App 内打开。", "err"); return; }
      try {
        showMsg("正在建立连接…");
        let gotUri = false;
        const slow = setTimeout(() => { if (!gotUri) showUrlQr(); }, 6000);
        const clearSlow = () => clearTimeout(slow);
        wcProvider = await W.EthereumProvider.init({
          projectId: pid, chains: [BSC_CHAIN_ID], optionalChains: [BSC_CHAIN_ID], showQrModal: false,
          methods: ["eth_sendTransaction", "eth_requestAccounts", "eth_accounts", "eth_chainId", "wallet_switchEthereumChain"],
          events: ["chainChanged", "accountsChanged"],
        });
        wcProvider.on("display_uri", (arg) => {
          let uri = typeof arg === "string" ? arg : arg && (arg.uri || arg.data || arg.params);
          if (uri && typeof uri !== "string") uri = String(uri.uri || uri.data || uri);
          gotUri = true; clearSlow(); showQr(uri || "");
        });
        const accs = await wcProvider.request({ method: "eth_requestAccounts" });
        clearSlow(); closeQr();
        if ($("awBadge")) { $("awBadge").textContent = "已连接"; $("awBadge").classList.add("ok"); }
        await applyConnected(wcProvider, accs[0]);
      } catch (e) {
        clearSlow(); closeQr();
        showMsg("WalletConnect 连接失败：" + ((e && e.shortMessage) || e.message || e), "err");
      }
      return;
    }
    showMsg("当前环境无法加载扫码组件，请改用浏览器钱包或在币安 App 内打开。", "err");
  }

  function onAccountChanged(addr) {
    currentAccount = addr;
    if (tokenContract && addr) refreshAccount();
    else if (!addr) {
      $("topWallet").textContent = "未连接";
      $("connectBtn").textContent = "连接币安 AI 钱包";
    }
  }

  /* ---------- 加载合约信息 ---------- */
  async function loadInfo() {
    contractAddr = ($("contract").value || "").trim();
    if (!ethers.isAddress(contractAddr)) return showMsg("请输入有效的合约地址", "err");
    $("bscLink").href = EXPLORER + "/address/" + contractAddr;
    try {
      tokenContract = new ethers.Contract(contractAddr, window.AI888V4Artifact.abi, readProv());
      const c = tokenContract;
      const [name, symbol, dec, price, max, mintAll, start, requiredNFT, maxMint,
        buyHold, buyLP, buyMkt, buyBurn, sellHold, sellLP, sellMkt, sellBurn] = await Promise.all([
        c.name(), c.symbol(), c.decimals(), c.Mint_Once_BNB(),
        c.Mint_Count_Max(), c.MintAllBNB(), c.startTradeBlock(),
        c.requiredNFT(), c.maxMintPerAddr(),
        c._buyHoldRewardFee(), c._buyLPFee(), c._buyMarketingFee(), c.buy_burnFee(),
        c._sellHoldRewardFee(), c._sellLPFee(), c._sellMarketingFee(), c.sell_burnFee(),
      ]);
      meta = {
        name, symbol, decimals: Number(dec),
        price, max, mintAll, requiredNFT, maxMint, start,
      };

      const count = price > 0n ? Number(mintAll / price) : 0;
      const remaining = max - BigInt(count);

      $("heroName").textContent = name;
      $("heroSymbol").textContent = symbol;
      $("topName").textContent = name;
      document.title = name + " · " + symbol + " 铸造";

      $("infoName").textContent = name;
      $("infoSymbol").textContent = symbol;
      $("infoPrice").textContent = ethers.formatEther(price) + " BNB / 份";
      $("infoProgress").textContent = count + " / " + max.toString() + " 份";

      const pct = max > 0n ? Math.min(100, (count / Number(max)) * 100) : 0;
      $("progBar").style.width = pct.toFixed(1) + "%";
      $("progPct").textContent = pct.toFixed(1) + "%";
      $("progOf").textContent = count + " / " + max.toString() + " 份";
      $("progRaised").textContent = ethers.formatEther(mintAll) + " BNB";
      $("progLeft").textContent = remaining.toString() + " 份";
      $("progPrice").textContent = ethers.formatEther(price) + " BNB";
      $("progState").textContent = start == 0n ? "未开盘（铸造中）" : "已开盘";
      $("progStatus").textContent = start == 0n ? "铸造进行中" : "已结束";

      $("infoStatus").textContent = start == 0n ? "未开盘（铸造中）" : "已开盘";

      // 费率明细（来自合约，开盘后锁定）
      const feePct = (v) => (Number(v) / 100).toFixed(2) + "%";
      const buyTotal = buyHold + buyLP + buyMkt + buyBurn;
      const sellTotal = sellHold + sellLP + sellMkt + sellBurn;
      $("feeBuyHold").textContent = feePct(buyHold);
      $("feeBuyLP").textContent = feePct(buyLP);
      $("feeBuyMarketing").textContent = feePct(buyMkt);
      $("feeBuyBurn").textContent = feePct(buyBurn);
      $("feeBuyTotal").textContent = feePct(buyTotal);
      $("feeSellHold").textContent = feePct(sellHold);
      $("feeSellLP").textContent = feePct(sellLP);
      $("feeSellMarketing").textContent = feePct(sellMkt);
      $("feeSellBurn").textContent = feePct(sellBurn);
      $("feeSellTotal").textContent = feePct(sellTotal);
      $("feeCard").classList.remove("hidden");
      $("heroSub").textContent =
        "向合约发送 BNB 即可铸造 · 买入 " + feePct(buyTotal) + " / 卖出 " + feePct(sellTotal) +
        " 手续费（持币分红 / 回流 LP / 营销 / 销毁）";

      $("tokenInfo").classList.remove("hidden");
      $("addTokenBtn").classList.remove("hidden");
      $("mintBtn").disabled = start != 0n;
      if (start != 0n) showMsg("该代币已开盘，铸造已结束。", "err");
      else showMsg("已加载 " + name + " (" + symbol + ")", "ok");

      if (currentAccount) await refreshAccount();
    } catch (e) {
      showMsg("加载失败：" + (e.reason || e.message || e), "err");
    }
  }

  /* ---------- 当前账户信息 ---------- */
  async function refreshAccount() {
    if (!tokenContract || !currentAccount) return;
    const c = tokenContract;
    try {
      const [bal, mintedCount] = await Promise.all([
        c.balanceOf(currentAccount),
        c.mintCount(currentAccount),
      ]);
      $("infoBal").textContent = ethers.formatUnits(bal, meta.decimals);
      const maxMint = meta.maxMint;
      $("infoMinted").textContent = maxMint == 0n ? "不限" : (mintedCount.toString() + " / " + maxMint.toString());
      const left = maxMint == 0n ? Infinity : Number(maxMint) - Number(mintedCount);
      $("infoMyLeft").textContent = maxMint == 0n ? "不限" : (left > 0 ? left + " 份" : "已达上限");

      if (meta.requiredNFT && meta.requiredNFT !== ethers.ZeroAddress) {
        try {
          const nft = new ethers.Contract(
            meta.requiredNFT,
            ["function balanceOf(address) view returns (uint256)"],
            readProv()
          );
          const nbal = await nft.balanceOf(currentAccount);
          $("infoNFT").textContent = nbal > 0n ? "已持有 ✅" : "未持有 ❌（无法铸造）";
        } catch {
          $("infoNFT").textContent = meta.requiredNFT;
        }
      } else {
        $("infoNFT").textContent = "无门槛";
      }
    } catch (_) { /* 忽略 */ }
  }

  /* ---------- 铸造 ---------- */
  async function mint() {
    if (!tokenContract) return showMsg("请先加载合约信息", "err");
    if (!currentAccount) return showMsg("请先连接钱包", "err");
    if (meta.start != 0n) return showMsg("已开盘，铸造已结束", "err");

    let n = parseInt($("mintQty").value || "1", 10);
    if (!Number.isFinite(n) || n < 1) n = 1;
    n = Math.min(n, 10);

    try {
      const mintedCount = await tokenContract.mintCount(currentAccount);
      const maxMint = meta.maxMint;
      if (maxMint != 0n) {
        const can = Number(maxMint) - Number(mintedCount);
        if (can <= 0) return showMsg("该地址已达到最大铸造次数（" + maxMint.toString() + "）", "err");
        n = Math.min(n, can);
      }

      const price = meta.price;
      showMsg("准备铸造 " + n + " 份，共 " + ethers.formatEther(price * BigInt(n)) + " BNB，请在钱包逐笔确认…", "");
      for (let i = 0; i < n; i++) {
        const tx = await signer.sendTransaction({ to: contractAddr, value: price });
        showMsg("第 " + (i + 1) + " / " + n + " 笔已提交：" + tx.hash, "ok");
        await tx.wait();
      }
      showMsg("✅ 铸造成功（" + n + " 份），可在 BscScan 查看", "ok");
      await loadInfo();
    } catch (e) {
      showMsg("铸造失败：" + (e.reason || e.message || e), "err");
    }
  }

  /* ---------- 添加到钱包 ---------- */
  async function addToken() {
    const eth = window.ethereum || window.BinanceChain;
    if (!eth || !meta.symbol) return;
    try {
      await eth.request({
        method: "wallet_watchAsset",
        params: {
          type: "ERC20",
          options: {
            address: contractAddr,
            symbol: meta.symbol,
            decimals: meta.decimals,
            image: "",
          },
        },
      });
    } catch (e) {
      showMsg("添加失败：" + (e.message || e), "err");
    }
  }

  /* ---------- 份数步进 ---------- */
  function setQty(v) {
    v = Math.max(1, Math.min(10, v | 0));
    $("mintQty").value = v;
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    $("connectBtn").addEventListener("click", connect);
    const _qrCancel = $("qrCancel");
    if (_qrCancel) _qrCancel.addEventListener("click", () => { clearAgenticLogin(); closeQr(); });
    $("loadBtn").addEventListener("click", loadInfo);
    $("mintBtn").addEventListener("click", mint);
    $("addTokenBtn").addEventListener("click", addToken);
    $("qtyMinus").addEventListener("click", () => setQty(parseInt($("mintQty").value || "1", 10) - 1));
    $("qtyPlus").addEventListener("click", () => setQty(parseInt($("mintQty").value || "1", 10) + 1));
    $("mintQty").addEventListener("change", (e) => setQty(parseInt(e.target.value || "1", 10)));

    const eth = window.ethereum || window.BinanceChain;
    if (eth && eth.on) {
      eth.on("accountsChanged", (accs) => {
        currentAccount = accs && accs[0] ? accs[0] : null;
        if (currentAccount) {
          onAccountChanged(currentAccount);
        } else {
          signer = null;
          $("connectBtn").textContent = "连接币安 AI 钱包";
          $("topWallet").textContent = "未连接";
        }
        if (tokenContract) loadInfo();
      });
      eth.on("chainChanged", () => location.reload());
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    initPandaBg();
    bind();
    // 默认合约地址已填在输入框，打开页面自动加载一次信息
    if (ethers.isAddress($("contract").value.trim())) loadInfo();
    // 手机从币安 App 返回后自动恢复登录态
    restoreAgenticSession().catch(() => {});
  });
})();
