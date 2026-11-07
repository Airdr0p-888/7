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

  /* ---------- 熊猫主题漂浮背景（竹叶/脚印/熊猫） ---------- */
  function initPandaBg() {
    const cv = $("pandaBg");
    if (!cv) return;
    const ctx = cv.getContext("2d");
    let w, h, items;
    const glyphs = ["🎋", "🐾", "🐼", "🍃"];
    function resize() {
      w = cv.width = window.innerWidth;
      h = cv.height = window.innerHeight;
      const n = Math.min(42, Math.floor(w / 26));
      items = Array.from({ length: n }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        r: 20 + Math.random() * 22,
        s: 0.3 + Math.random() * 0.9,
        d: (Math.random() - 0.5) * 0.6,
        a: 0.16 + Math.random() * 0.28,
        g: glyphs[Math.floor(Math.random() * glyphs.length)],
        rot: Math.random() * Math.PI,
      }));
    }
    function draw() {
      ctx.clearRect(0, 0, w, h);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const f of items) {
        f.y += f.s;
        f.x += f.d;
        f.rot += 0.003;
        if (f.y > h + 30) { f.y = -30; f.x = Math.random() * w; }
        if (f.x > w + 30) f.x = -30;
        if (f.x < -30) f.x = w + 30;
        ctx.save();
        ctx.globalAlpha = f.a;
        ctx.translate(f.x, f.y);
        ctx.rotate(f.rot);
        ctx.font = f.r + "px serif";
        ctx.fillText(f.g, 0, 0);
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

  /* ---------- 连接钱包 ---------- */
  async function connect() {
    const eth = window.ethereum || window.BinanceChain;
    if (!eth) {
      showMsg("未检测到钱包：请用币安 App 的 DApp 浏览器打开本站，或安装币安钱包 / MetaMask 插件。", "err");
      return;
    }
    try {
      await eth.request({ method: "eth_requestAccounts" });
      provider = new ethers.BrowserProvider(eth);
      signer = await provider.getSigner();
      currentAccount = await signer.getAddress();
      onAccountChanged(currentAccount);
      await ensureNetwork();
      $("connectBtn").textContent = shortAddr(currentAccount);
      $("topWallet").textContent = shortAddr(currentAccount);
      showMsg("钱包已连接：" + currentAccount, "ok");
      if (contractAddr) loadInfo();
    } catch (e) {
      showMsg("连接失败：" + (e.message || e), "err");
    }
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

      const pct = max > 0n ? Math.min(100, (count / max) * 100) : 0;
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
  });
})();
