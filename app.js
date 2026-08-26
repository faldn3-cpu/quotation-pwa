// ====================================================
// 系統設定
// ====================================================
const GAS_URL = "https://script.google.com/macros/s/AKfycbx48PMWVPysN9gd4OcPq1JmzqkRzwu494C2jFxK71Al13Q4Lr2y5KP3RbS80pgs8CYxGg/exec";
const WEB_CLIENT_ID = "668571991428-ffjs6ud0apusi7akb0lmptae24qqtbto.apps.googleusercontent.com";
const DRIVE_SCOPES = "https://www.googleapis.com/auth/drive.readonly profile email";
const BACKUP_FOLDER_NAME = "報價系統備份";
const CUSTOMERS_FILE_NAME = "customers.json";

// 庫存對照表：產品型號(小寫) → 可用數量（從 L廠庫存試算表同步）
let STOCK_MAP = {};

// ====================================================
// 全域狀態
// ====================================================
let MOCK_CUSTOMERS = [];
let MOCK_PRODUCTS = [];
let tokenClient = null;
let accessToken = null;
let userProfile = null;

document.addEventListener("DOMContentLoaded", () => {

  // --- DOM 元素 ---
  const loginSection      = document.getElementById("loginSection");
  const draftSection      = document.getElementById("draftSection");
  const successSection    = document.getElementById("successSection");
  const loadingOverlay    = document.getElementById("loadingOverlay");
  const offlineIndicator  = document.getElementById("offlineIndicator");
  const btnLogin          = document.getElementById("btnLogin");
  const btnSync           = document.getElementById("btnSync");
  const btnAddItem        = document.getElementById("btnAddItem");
  const btnSubmitDraft    = document.getElementById("btnSubmitDraft");
  const btnNewDraft       = document.getElementById("btnNewDraft");
  const itemsContainer    = document.getElementById("itemsContainer");
  const customerNameInput = document.getElementById("customerName");
  const customerSuggestions = document.getElementById("customerSuggestions");
  const productModal      = document.getElementById("productModal");
  const btnCloseModal     = document.getElementById("btnCloseModal");
  const productSearch     = document.getElementById("productSearch");
  const productResults    = document.getElementById("productResults");
  const userInfoBadge     = document.getElementById("userInfoBadge");

  let currentEditingItemIndex = -1;
  let itemCount = 0;

  // ====================================================
  // Service Worker 註冊
  // ====================================================
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('[PWA] Service Worker 已註冊', reg))
      .catch(err => console.error('[PWA] Service Worker 註冊失敗:', err));
  }

  // ====================================================
  // 網路狀態監測
  // ====================================================
  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);

  function updateOnlineStatus() {
    if (navigator.onLine) {
      offlineIndicator.classList.add("hidden");
      if ('serviceWorker' in navigator && 'SyncManager' in window) {
        navigator.serviceWorker.ready.then(reg => reg.sync.register('sync-drafts'));
      }
    } else {
      offlineIndicator.classList.remove("hidden");
    }
  }
  updateOnlineStatus();

  // ====================================================
  // Google Identity Services 初始化
  // 使用 Token Model (Implicit Flow)，適合純前端 PWA
  // ====================================================
  function initGoogleAuth() {
    if (typeof google === "undefined" || !google.accounts) {
      // GIS SDK 尚未載入完成，稍後重試
      setTimeout(initGoogleAuth, 300);
      return;
    }

    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: WEB_CLIENT_ID,
      scope: DRIVE_SCOPES,
      callback: handleTokenResponse,
    });
    console.log("[Auth] Google Identity Services 初始化完成");
  }

  // GIS SDK 非同步載入，DOMContentLoaded 時可能還未就緒
  if (typeof google !== "undefined" && google.accounts) {
    initGoogleAuth();
  } else {
    // 等待 script onload
    const gisScript = document.querySelector('script[src*="accounts.google.com/gsi/client"]');
    if (gisScript) {
      gisScript.addEventListener('load', initGoogleAuth);
    } else {
      setTimeout(initGoogleAuth, 1000);
    }
  }

  // ====================================================
  // 登入按鈕點擊
  // ====================================================
  btnLogin.addEventListener("click", () => {
    if (!tokenClient) {
      alert("Google 登入模組尚在載入中，請稍後再試。");
      return;
    }
    if (!navigator.onLine) {
      // 離線：嘗試讀取快取資料直接進入
      loadFromCache();
      enterDraftMode("離線使用者");
      return;
    }
    // 發起 OAuth 授權請求（彈出 Google 選帳號視窗）
    tokenClient.requestAccessToken({ prompt: 'select_account' });
  });

  // ====================================================
  // OAuth 授權回呼
  // ====================================================
  async function handleTokenResponse(response) {
    if (response.error) {
      console.error("[Auth] 授權失敗:", response.error, response.error_description);
      alert("Google 登入失敗：" + (response.error_description || response.error));
      return;
    }

    accessToken = response.access_token;
    console.log("[Auth] 已取得存取權杖");

    // 顯示載入畫面
    loadingOverlay.classList.remove("hidden");

    try {
      // 1. 取得使用者基本資料
      userProfile = await fetchUserProfile();
      console.log("[Auth] 使用者：", userProfile.name, "/", userProfile.email);

      // 2. 載入資料（客戶 + 產品）
      await initData();

      // 3. 進入報價表單
      enterDraftMode(userProfile.name || userProfile.email);

    } catch (err) {
      console.error("[Auth] 登入後初始化失敗:", err);
      alert("資料載入失敗，請重新整理後再試。\n錯誤：" + err.message);
    } finally {
      loadingOverlay.classList.add("hidden");
    }
  }

  // ====================================================
  // 取得使用者個人資料
  // ====================================================
  async function fetchUserProfile() {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) throw new Error("無法取得使用者資料");
    return await res.json();
  }

  // ====================================================
  // 進入報價草稿模式（切換畫面）
  // ====================================================
  function enterDraftMode(displayName) {
    // 顯示使用者徽章
    userInfoBadge.textContent = "👤 " + displayName;
    userInfoBadge.classList.remove("hidden");
    btnSync.classList.remove("hidden");

    // 切換區塊
    loginSection.classList.add("hidden");
    draftSection.classList.remove("hidden");
    successSection.classList.add("hidden");

    // 清除並預設一個空白品項
    itemsContainer.innerHTML = "";
    itemCount = 0;
    addBlankItem();
  }

  // ====================================================
  // 同步資料（右上角重新整理按鈕）
  // ====================================================
  btnSync.addEventListener("click", async () => {
    if (!navigator.onLine) {
      alert("目前為離線狀態，無法同步。");
      return;
    }
    if (!accessToken) {
      alert("請先登入。");
      return;
    }
    loadingOverlay.classList.remove("hidden");
    await initData();
    loadingOverlay.classList.add("hidden");
    const stockCount = Object.keys(STOCK_MAP).length;
    alert(`✅ 資料同步完成！\n\n• 客戶資料：${MOCK_CUSTOMERS.length} 筆\n• 產品項目：${MOCK_PRODUCTS.length} 筆\n• 庫存報表：${stockCount} 筆`);
  });

  // ====================================================
  // 初始化雲端資料載入
  // ====================================================
  async function initData() {
    await Promise.allSettled([
      loadCustomersFromDrive(),
      loadProductsFromGAS(),
      loadInventoryFromGAS()
    ]);
  }

  // ====================================================
  // 從快取讀取（離線模式）
  // ====================================================
  function loadFromCache() {
    try {
      MOCK_CUSTOMERS = JSON.parse(localStorage.getItem("customers_cache") || "[]");
      MOCK_PRODUCTS  = JSON.parse(localStorage.getItem("products_cache")  || "[]");
      console.log("[快取] 客戶:", MOCK_CUSTOMERS.length, "筆 / 產品:", MOCK_PRODUCTS.length, "筆");
    } catch (e) {
      console.error("[快取] 讀取失敗:", e);
    }
  }

  // ====================================================
  // 從業務員個人 Google Drive 讀取客戶資料
  // 路徑：報價系統備份 / customers.json
  // ====================================================
  async function loadCustomersFromDrive() {
    if (!accessToken) return;
    try {
      // Step 1：搜尋「報價系統備份」資料夾
      const folderQuery = encodeURIComponent(
        `name='${BACKUP_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
      );
      const folderRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${folderQuery}&spaces=drive&fields=files(id,name)`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!folderRes.ok) {
        const errText = await folderRes.text();
        throw new Error(`Drive API 錯誤 ${folderRes.status}：${errText.substring(0, 150)}`);
      }
      const folderData = await folderRes.json();
      const folders = folderData.files || [];

      if (folders.length === 0) {
        console.warn("[Drive] 找不到「報價系統備份」資料夾");
        MOCK_CUSTOMERS = JSON.parse(localStorage.getItem("customers_cache") || "[]");
        if (MOCK_CUSTOMERS.length === 0) {
          showStatusBanner("⚠️ 尚無客戶資料：請先在電腦版執行一次 Google Drive 備份", "warn");
        }
        return;
      }

      const folderId = folders[0].id;

      // Step 2：搜尋 customers.json
      const fileQuery = encodeURIComponent(
        `name='${CUSTOMERS_FILE_NAME}' and '${folderId}' in parents and trashed=false`
      );
      const fileRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${fileQuery}&spaces=drive&fields=files(id,name,modifiedTime)`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const fileData = await fileRes.json();
      const files = fileData.files || [];

      if (files.length === 0) {
        console.warn("[Drive] 找不到 customers.json，改用快取");
        MOCK_CUSTOMERS = JSON.parse(localStorage.getItem("customers_cache") || "[]");
        return;
      }

      const fileId = files[0].id;

      // Step 3：下載檔案內容
      const downloadRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!downloadRes.ok) throw new Error("下載失敗：" + downloadRes.status);

      MOCK_CUSTOMERS = await downloadRes.json();
      localStorage.setItem("customers_cache", JSON.stringify(MOCK_CUSTOMERS));
      console.log("[Drive] 客戶資料同步成功，共", MOCK_CUSTOMERS.length, "筆");

    } catch (e) {
      console.error("[Drive] 讀取客戶資料失敗:", e);
      MOCK_CUSTOMERS = JSON.parse(localStorage.getItem("customers_cache") || "[]");
      if (MOCK_CUSTOMERS.length === 0) {
        showStatusBanner("❌ 客戶資料讀取失敗：" + e.message.substring(0, 80), "error");
      }
    }
  }

  // ====================================================
  // 從 GAS 代理讀取庫存對照表（L廠庫存數量報表）
  // ====================================================
  async function loadInventoryFromGAS() {
    try {
      const res = await fetch(`${GAS_URL}?action=get_inventory`);
      const data = await res.json();
      if (data.status === "ok" && data.data) {
        STOCK_MAP = data.data;
        console.log("[GAS] 庫存同步成功，共", Object.keys(STOCK_MAP).length, "筆");
      } else {
        console.warn("[GAS] 庫存讀取異常:", data.msg);
      }
    } catch(e) {
      console.warn("[GAS] 庫存讀取失敗（使用離線模式）:", e.message);
    }
  }

  // ====================================================
  // 查詢某產品型號的實際庫存數量
  // ====================================================
  function getStockQty(code) {
    if (!code || Object.keys(STOCK_MAP).length === 0) return null;
    // 正規化：去除括號內容、非英數字元，轉小寫
    const normalize = s => s.replace(/[（(].*?[)）]/g, "").replace(/[^a-zA-Z0-9.]/g, "").toLowerCase();
    const key = normalize(code);
    // 直接比對
    if (STOCK_MAP[key] !== undefined) return STOCK_MAP[key];
    // 原始小寫比對（保留連字號）
    const keyRaw = code.replace(/[（(].*?[)）]/g, "").trim().toLowerCase();
    if (STOCK_MAP[keyRaw] !== undefined) return STOCK_MAP[keyRaw];
    return null;
  }

  // ====================================================
  // 顯示狀態提示橫幅（非阻斷式，3 秒後消失）
  // ====================================================
  function showStatusBanner(msg, type = "info") {
    let banner = document.getElementById("statusBanner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "statusBanner";
      banner.style.cssText = "position:fixed;top:64px;left:0;right:0;z-index:300;padding:10px 16px;font-size:0.85rem;font-weight:600;text-align:center;transition:opacity 0.4s;";
      document.body.appendChild(banner);
    }
    const colors = { info: "#2563eb", warn: "#d97706", error: "#dc2626" };
    banner.style.background = colors[type] || colors.info;
    banner.style.color = "#fff";
    banner.style.opacity = "1";
    banner.textContent = msg;
    setTimeout(() => { banner.style.opacity = "0"; }, 5000);
  }

  // ====================================================
  // 透過 GAS 代理讀取共用產品資料
  // （GAS 以專案擁有者身分存取，不受業務員帳號權限限制）
  // ====================================================
  async function loadProductsFromGAS() {
    try {
      const res = await fetch(`${GAS_URL}?action=get_products`);
      if (!res.ok) throw new Error("GAS 回應錯誤：" + res.status);
      const data = await res.json();

      if (data.status === "ok" && Array.isArray(data.data)) {
        MOCK_PRODUCTS = data.data;
        localStorage.setItem("products_cache", JSON.stringify(MOCK_PRODUCTS));
        console.log("[GAS] 產品資料同步成功，共", MOCK_PRODUCTS.length, "筆");
      } else {
        throw new Error(data.msg || "GAS 回傳格式異常");
      }
    } catch (e) {
      console.error("[GAS] 讀取產品資料失敗:", e);
      MOCK_PRODUCTS = JSON.parse(localStorage.getItem("products_cache") || "[]");
    }
  }

  // ====================================================
  // 客戶名稱搜尋提示與自動補全
  // ====================================================
  function showCustomerSuggestions(filterText = "") {
    const val = filterText.trim().toLowerCase();
    let matches = [];
    if (!val) {
      // 未輸入文字時，預設顯示前 20 筆
      matches = MOCK_CUSTOMERS.slice(0, 20);
    } else {
      matches = MOCK_CUSTOMERS.filter(c => {
        const name = typeof c === 'string' ? c : (c.name || "");
        const taxId = typeof c === 'object' && c.tax_id ? c.tax_id : "";
        return name.toLowerCase().includes(val) || taxId.includes(val);
      }).slice(0, 25);
    }

    if (matches.length > 0) {
      customerSuggestions.innerHTML = matches.map(c => {
        const name = typeof c === 'string' ? c : (c.name || "");
        const taxId = typeof c === 'object' && c.tax_id ? ` <span style="color:#64748b;font-size:0.75rem;">(${c.tax_id})</span>` : "";
        return `<div class="suggestion-item" data-name="${name}">${name}${taxId}</div>`;
      }).join("");
      customerSuggestions.classList.remove("hidden");
    } else {
      if (val) {
        customerSuggestions.innerHTML = `<div class="suggestion-item text-muted" style="color:#94a3b8;">找不到相符客戶（可直接輸入新客戶名稱）</div>`;
        customerSuggestions.classList.remove("hidden");
      } else {
        customerSuggestions.classList.add("hidden");
      }
    }
  }

  customerNameInput.addEventListener("focus", () => {
    showCustomerSuggestions(customerNameInput.value);
  });

  customerNameInput.addEventListener("input", (e) => {
    showCustomerSuggestions(e.target.value);
  });

  // 點擊外部關閉客戶選單
  document.addEventListener("click", (e) => {
    if (!customerNameInput.contains(e.target) && !customerSuggestions.contains(e.target)) {
      customerSuggestions.classList.add("hidden");
    }
  });

  customerSuggestions.addEventListener("click", (e) => {
    const item = e.target.closest(".suggestion-item");
    if (item && item.dataset.name) {
      customerNameInput.value = item.dataset.name;
      customerSuggestions.classList.add("hidden");
    }
  });

  // ====================================================
  // 新增品項
  // ====================================================
  function addBlankItem() {
    itemCount++;
    const itemId = `item-${itemCount}`;
    const itemHTML = `
      <div class="item-row" id="${itemId}">
        <div class="item-header">
          <div class="item-title" id="${itemId}-title">點擊選擇產品...</div>
          <button type="button" class="item-remove" onclick="document.getElementById('${itemId}').remove()">&times;</button>
        </div>
        <div id="${itemId}-info" style="font-size:0.8rem; color:#2563eb; margin: 4px 0 8px 0; display:none;"></div>
        <div class="item-details">
          <div>
            <label>數量</label>
            <input type="number" name="quantity" min="1" value="1" required>
          </div>
          <div>
            <label>現場參考價</label>
            <input type="number" name="ref_price" id="${itemId}-ref-price" placeholder="選填">
          </div>
        </div>
        <input type="hidden" name="item_code" id="${itemId}-code">
        <input type="hidden" name="item_name" id="${itemId}-name">
      </div>
    `;
    itemsContainer.insertAdjacentHTML('beforeend', itemHTML);

    const titleEl = document.getElementById(`${itemId}-title`);
    titleEl.style.cursor = "pointer";
    titleEl.style.color = "var(--primary-color)";
    titleEl.addEventListener("click", () => {
      currentEditingItemIndex = itemId;
      productModal.classList.remove("hidden");
      productSearch.value = "";
      renderProducts(MOCK_PRODUCTS);
      productSearch.focus();
    });
  }

  btnAddItem.addEventListener("click", addBlankItem);

  // ====================================================
  // 產品選擇 Modal
  // ====================================================
  btnCloseModal.addEventListener("click", () => productModal.classList.add("hidden"));

  productSearch.addEventListener("input", (e) => {
    const val = e.target.value.toLowerCase();
    const matches = MOCK_PRODUCTS.filter(p =>
      (p.code || "").toLowerCase().includes(val) ||
      (p.name || "").toLowerCase().includes(val)
    );
    renderProducts(matches);
  });

  function renderProducts(products) {
    if (products.length === 0) {
      productResults.innerHTML = `<div class="text-center text-muted mt-3">找不到符合的產品</div>`;
      return;
    }
    productResults.innerHTML = products.map(p => {
      // 庫存：優先使用試算表即時數量，備援使用 DB 的 IN_STOCK 狀態
      const qty = getStockQty(p.code);
      let stockBadge;
      if (qty !== null) {
        if (qty > 0) {
          stockBadge = `<span class="stock-badge stock-in">現貨 ${qty}</span>`;
        } else {
          stockBadge = `<span class="stock-badge stock-out">零庫存</span>`;
        }
      } else {
        // 試算表未比對到，用 products.json 的 stock_status 顯示
        stockBadge = p.stock === "IN_STOCK"
          ? `<span class="stock-badge stock-in">現貨</span>`
          : `<span class="stock-badge stock-out">期貨</span>`;
      }

      // 價格顯示
      const dealerPrice = p.dealer_price ? `<span style="color:var(--primary-color);">經銷 $${Number(p.dealer_price).toLocaleString()}</span>` : "";
      const listPrice   = p.list_price   ? `<span style="color:var(--text-muted);">定價 $${Number(p.list_price).toLocaleString()}</span>`   : "";
      const priceLine   = (dealerPrice || listPrice)
        ? `<div style="font-size:0.8rem; display:flex; gap:10px; margin-top:3px;">${dealerPrice}${listPrice}</div>`
        : "";

      return `
        <div class="product-item" data-code="${p.code}" data-name="${p.name}">
          <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
            <strong>${p.code}</strong>
            ${stockBadge}
          </div>
          <div style="color:var(--text-muted); font-size:0.875rem;">${p.name}</div>
          ${priceLine}
        </div>
      `;
    }).join("");
  }

  productResults.addEventListener("click", (e) => {
    const item = e.target.closest(".product-item");
    if (item && currentEditingItemIndex) {
      const code = item.dataset.code;
      const name = item.dataset.name;
      const productObj = MOCK_PRODUCTS.find(p => p.code === code) || {};
      
      const qty = getStockQty(code);
      let stockStr = "";
      if (qty !== null) {
        stockStr = qty > 0 ? `現貨: ${qty}` : "零庫存";
      } else {
        stockStr = productObj.stock === "IN_STOCK" ? "現貨" : "期貨";
      }
      
      const dPrice = productObj.dealer_price ? Number(productObj.dealer_price).toLocaleString() : "";
      
      document.getElementById(`${currentEditingItemIndex}-title`).textContent = `[${code}] ${name}`;
      document.getElementById(`${currentEditingItemIndex}-title`).style.color = "var(--text-main)";
      document.getElementById(`${currentEditingItemIndex}-code`).value = code;
      document.getElementById(`${currentEditingItemIndex}-name`).value = name;
      
      // 更新即時資訊列
      const infoEl = document.getElementById(`${currentEditingItemIndex}-info`);
      if (infoEl) {
        infoEl.textContent = `經銷價: $${dPrice || '未定'} | 庫存: ${stockStr}`;
        infoEl.style.display = "block";
      }
      
      // 填入參考價預設 placeholder
      const refInput = document.getElementById(`${currentEditingItemIndex}-ref-price`);
      if (refInput && productObj.dealer_price) {
        refInput.placeholder = `經銷 $${dPrice}`;
      }
      
      productModal.classList.add("hidden");
    }
  });

  // ====================================================
  // 送出草稿
  // ====================================================
  document.getElementById("draftForm").addEventListener("submit", async (e) => {
    e.preventDefault();

    const customer = customerNameInput.value;
    const items = [];
    const itemRows = itemsContainer.querySelectorAll(".item-row");

    if (itemRows.length === 0) {
      alert("請至少加入一個品項");
      return;
    }

    let hasError = false;
    itemRows.forEach(row => {
      const code     = row.querySelector("input[name='item_code']").value;
      const name     = row.querySelector("input[name='item_name']").value;
      const qty      = row.querySelector("input[name='quantity']").value;
      const refPrice = row.querySelector("input[name='ref_price']").value;
      if (!code) {
        hasError = true;
      } else {
        items.push({ code, name, quantity: parseInt(qty), ref_price: parseFloat(refPrice) || null });
      }
    });

    if (hasError) {
      alert("請確實選擇產品品項。");
      return;
    }

    const draftData = {
      email:     userProfile ? userProfile.email : "unknown",
      name:      userProfile ? (userProfile.name || userProfile.email) : "unknown",
      customer:  customer,
      items:     items,
      timestamp: new Date().toISOString()
    };

    if (navigator.onLine) {
      loadingOverlay.classList.remove("hidden");
      try {
        const res = await fetch(`${GAS_URL}?action=draft`, {
          method: 'POST',
          body: JSON.stringify(draftData),
          headers: { 'Content-Type': 'text/plain;charset=utf-8' }
        });
        const resData = await res.json();
        if (resData.status !== "ok") throw new Error(resData.msg || "未知錯誤");
        loadingOverlay.classList.add("hidden");
        draftSection.classList.add("hidden");
        successSection.classList.remove("hidden");
      } catch (err) {
        loadingOverlay.classList.add("hidden");
        alert("上傳失敗，請稍後再試: " + err.message);
      }
    } else {
      let drafts = JSON.parse(localStorage.getItem("offlineDrafts") || "[]");
      drafts.push(draftData);
      localStorage.setItem("offlineDrafts", JSON.stringify(drafts));
      draftSection.classList.add("hidden");
      successSection.classList.remove("hidden");
    }
  });

  btnNewDraft.addEventListener("click", () => {
    customerNameInput.value = "";
    itemsContainer.innerHTML = "";
    itemCount = 0;
    addBlankItem();
    successSection.classList.add("hidden");
    draftSection.classList.remove("hidden");
  });

  // ====================================================
  // OCR 名片辨識邏輯
  // ====================================================
  const btnNewCustomer    = document.getElementById("btnNewCustomer");
  const customerOcrModal  = document.getElementById("customerOcrModal");
  const btnCloseOcr       = document.getElementById("btnCloseOcr");
  const cameraInput       = document.getElementById("cameraInput");
  const btnTriggerCamera  = document.getElementById("btnTriggerCamera");
  const ocrResultForm     = document.getElementById("ocrResultForm");
  const btnSaveOcrCustomer = document.getElementById("btnSaveOcrCustomer");

  if (btnNewCustomer) {
    btnNewCustomer.addEventListener("click", () => {
      customerOcrModal.classList.remove("hidden");
      ocrResultForm.classList.add("hidden");
    });

    btnCloseOcr.addEventListener("click", () => customerOcrModal.classList.add("hidden"));
    btnTriggerCamera.addEventListener("click", () => cameraInput.click());

    cameraInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (event) => {
        const base64Str = event.target.result.split(',')[1];
        const mimeType = file.type;
        loadingOverlay.classList.remove("hidden");
        try {
          await processOcr(base64Str, mimeType);
        } catch (err) {
          alert("OCR 辨識失敗：" + err.message);
        } finally {
          loadingOverlay.classList.add("hidden");
          cameraInput.value = "";
        }
      };
      reader.readAsDataURL(file);
    });

    async function processOcr(base64Str, mimeType) {
      const res = await fetch(`${GAS_URL}?action=ocr_card`, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ data: base64Str, mimeType: mimeType })
      });
      if (!res.ok) throw new Error(`網路錯誤: ${res.status}`);
      const resData = await res.json();
      if (resData.status !== "ok") throw new Error(resData.msg || "未知錯誤");
      const result = resData.data;
      document.getElementById("ocrCompany").value  = result.name    || "";
      document.getElementById("ocrTaxId").value    = result.tax_id  || "";
      document.getElementById("ocrContact").value  = result.contact || "";
      document.getElementById("ocrAddress").value  = result.address || "";
      document.getElementById("ocrPhone").value    = result.phone   || "";
      document.getElementById("ocrMobile").value   = result.mobile  || "";
      ocrResultForm.classList.remove("hidden");
    }

    btnSaveOcrCustomer.addEventListener("click", async () => {
      const name = document.getElementById("ocrCompany").value.trim();
      if (!name) { alert("公司名稱不能為空"); return; }

      const newCustomer = {
        id: "C" + Date.now(),
        name: name,
        tax_id:  document.getElementById("ocrTaxId").value.trim(),
        phone:   document.getElementById("ocrPhone").value.trim(),
        fax: "",
        address: document.getElementById("ocrAddress").value.trim(),
        payment_terms: "現金",
        status: "active",
        default_discount: 1.0,
        contacts: [{
          id: "CT" + Date.now(),
          name:   document.getElementById("ocrContact").value.trim(),
          email: "",
          mobile: document.getElementById("ocrMobile").value.trim()
        }]
      };

      MOCK_CUSTOMERS.push(newCustomer);
      loadingOverlay.classList.remove("hidden");
      try {
        const res = await fetch(`${GAS_URL}?action=save_customers`, {
          method: 'POST',
          body: JSON.stringify(MOCK_CUSTOMERS),
          headers: { 'Content-Type': 'text/plain;charset=utf-8' }
        });
        const resData = await res.json();
        if (resData.status !== "ok") throw new Error(resData.msg);
        alert("客戶建檔成功！已寫入雲端");
        customerOcrModal.classList.add("hidden");
        customerNameInput.value = name;
        localStorage.setItem("customers_cache", JSON.stringify(MOCK_CUSTOMERS));
      } catch (e) {
        alert("儲存至雲端失敗: " + e.message);
      } finally {
        loadingOverlay.classList.add("hidden");
      }
    });
  }

}); // end DOMContentLoaded
