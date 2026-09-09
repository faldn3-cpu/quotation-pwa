// ====================================================
// 系統設定
// ====================================================
const GAS_URL = "https://script.google.com/macros/s/AKfycbx48PMWVPysN9gd4OcPq1JmzqkRzwu494C2jFxK71Al13Q4Lr2y5KP3RbS80pgs8CYxGg/exec";
const WEB_CLIENT_ID = "668571991428-ffjs6ud0apusi7akb0lmptae24qqtbto.apps.googleusercontent.com";
const DRIVE_SCOPES = "https://www.googleapis.com/auth/drive.file profile email";
const BACKUP_FOLDER_NAME = "報價系統備份";
const CUSTOMERS_FILE_NAME = "customers.json";
const PRODUCTS_FILE_NAME = "products.json";

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
let pendingDraftAfterAuth = null;

function isTokenValid() {
  if (!accessToken) return false;
  const exp = parseInt(localStorage.getItem("google_token_expires_at") || "0", 10);
  return Date.now() < exp;
}

document.addEventListener("DOMContentLoaded", () => {

  // --- DOM 元素 ---
  const loginSection        = document.getElementById("loginSection");
  const draftSection        = document.getElementById("draftSection");
  const successSection      = document.getElementById("successSection");
  const loadingOverlay      = document.getElementById("loadingOverlay");
  const offlineIndicator    = document.getElementById("offlineIndicator");
  const btnLogin            = document.getElementById("btnLogin");
  const btnSync             = document.getElementById("btnSync");
  const btnAddItem          = document.getElementById("btnAddItem");
  const btnSubmitDraft      = document.getElementById("btnSubmitDraft");
  const btnNewDraft         = document.getElementById("btnNewDraft");
  const itemsContainer      = document.getElementById("itemsContainer");
  const customerNameInput   = document.getElementById("customerName");
  const userInfoBadge       = document.getElementById("userInfoBadge");

  // 客戶 Modal
  const customerModal       = document.getElementById("customerModal");
  const btnCloseCustomerModal = document.getElementById("btnCloseCustomerModal");
  const customerModalSearch = document.getElementById("customerModalSearch");
  const customerModalResults= document.getElementById("customerModalResults");
  const customerModalCount  = document.getElementById("customerModalCount");

  // 產品 Modal
  const productModal        = document.getElementById("productModal");
  const btnCloseModal       = document.getElementById("btnCloseModal");
  const productSearch       = document.getElementById("productSearch");
  const productResults      = document.getElementById("productResults");
  const btnConfirmProduct   = document.getElementById("btnConfirmProduct");

  // LINE Modal
  const lineModal           = document.getElementById("lineModal");
  const lineQuoteText       = document.getElementById("lineQuoteText");
  const btnLineQuote        = document.getElementById("btnLineQuote");
  const btnCopyLineQuote    = document.getElementById("btnCopyLineQuote");
  const btnCancelLineQuote  = document.getElementById("btnCancelLineQuote");
  const btnCloseLineModal   = document.getElementById("btnCloseLineModal");

  // 交期 Modal
  const deliveryModal            = document.getElementById("deliveryModal");
  const btnCloseDeliveryModal     = document.getElementById("btnCloseDeliveryModal");
  const customDeliveryInput      = document.getElementById("customDeliveryInput");
  const btnConfirmCustomDelivery = document.getElementById("btnConfirmCustomDelivery");
  const deliveryModalResults     = document.getElementById("deliveryModalResults");

  let currentEditingItemIndex = -1;
  let currentEditingDeliveryItemId = null;
  let selectedProductCode = null;
  let selectedProductName = null;
  let itemCount = 0;

  // 切換至登入卡片畫面
  function showLoginSection() {
    loginSection.classList.remove("hidden");
    draftSection.classList.add("hidden");
    if (successSection) successSection.classList.add("hidden");
    userInfoBadge.classList.add("hidden");
    btnSync.classList.add("hidden");
  }

  // ====================================================
  // Service Worker 註冊與自動更新偵測
  // ====================================================
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js?v=1.29')
      .then(reg => {
        console.log('[PWA] Service Worker 已註冊 (v 1.29)', reg);
        // 主動檢查伺服器端是否有新版 sw.js
        reg.update();

        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                console.log('[PWA] 偵測到新版本已安裝，即將自動重新整理...');
                window.location.reload();
              }
            });
          }
        });
      })
      .catch(err => console.error('[PWA] Service Worker 註冊失敗:', err));

    let isRefreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!isRefreshing) {
        isRefreshing = true;
        console.log('[PWA] Service Worker 控制權已更新，自動重載畫面');
        window.location.reload();
      }
    });
  }

  // ====================================================
  // 登入狀態記憶與自動進入
  // ====================================================
  let isSilentAuth = false;
  const hasLoggedIn = localStorage.getItem("has_logged_in") === "true";
  const savedDisplayName = localStorage.getItem("saved_display_name") || "已登入業務";

  // 檢查是否有儲存且尚未過期的 Token
  const savedToken = localStorage.getItem("google_access_token");
  const savedExpiresAt = parseInt(localStorage.getItem("google_token_expires_at") || "0", 10);
  if (savedToken && Date.now() < savedExpiresAt) {
    accessToken = savedToken;
    console.log("[Auth] 已復原有效之 Google Access Token (剩餘有效時間約", Math.round((savedExpiresAt - Date.now()) / 60000), "分鐘)");
  }

  // 嘗試載入離線快取資料以驗證本機是否具備品項/客戶資料
  loadFromCache();
  const hasLocalData = (MOCK_CUSTOMERS && MOCK_CUSTOMERS.length > 0) || (MOCK_PRODUCTS && MOCK_PRODUCTS.length > 0);

  if (hasLoggedIn && hasLocalData) {
    console.log("[Auth] 偵測到本機登入資訊與快取資料，直接進入報價表單：", savedDisplayName);
    try {
      const pStr = localStorage.getItem("saved_user_profile");
      if (pStr) userProfile = JSON.parse(pStr);
    } catch(e) {}
    enterDraftMode(savedDisplayName);
  } else {
    // 若無本機資料或無登入紀錄，顯示登入畫面以完成資料拉取
    console.log("[Auth] 顯示登入畫面 (hasLoggedIn:", hasLoggedIn, ", hasLocalData:", hasLocalData, ")");
    showLoginSection();
  }

  // 點擊使用者標籤可切換帳號或登出（若權杖失效則直接觸發重新授權）
  if (userInfoBadge) {
    userInfoBadge.addEventListener("click", () => {
      if (!isTokenValid()) {
        if (tokenClient) {
          isSilentAuth = false;
          tokenClient.requestAccessToken({ prompt: 'select_account' });
          return;
        }
      }
      if (confirm("是否要切換帳號或登出？")) {
        localStorage.removeItem("has_logged_in");
        localStorage.removeItem("saved_display_name");
        localStorage.removeItem("saved_user_profile");
        localStorage.removeItem("google_access_token");
        localStorage.removeItem("google_token_expires_at");
        localStorage.removeItem("cached_backup_folder_id");
        accessToken = null;
        userProfile = null;
        showLoginSection();
      }
    });
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
  // ====================================================
  function initGoogleAuth() {
    if (typeof google === "undefined" || !google.accounts) {
      setTimeout(initGoogleAuth, 300);
      return;
    }

    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: WEB_CLIENT_ID,
      scope: DRIVE_SCOPES,
      callback: handleTokenResponse,
    });
    console.log("[Auth] Google Identity Services 初始化完成");

    // 若本機已有登入紀錄，背景自動嘗試靜默續期
    if (hasLoggedIn && navigator.onLine) {
      console.log("[Auth] 背景執行靜默續期 Google 授權...");
      isSilentAuth = true;
      try {
        tokenClient.requestAccessToken({ prompt: 'none' });
      } catch (e) {
        console.warn("[Auth] 靜默續期呼叫失敗:", e);
        isSilentAuth = false;
      }
    }
  }

  if (typeof google !== "undefined" && google.accounts) {
    initGoogleAuth();
  } else {
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
      alert("Google 登入模組尚在載入中，請稍候再試。");
      return;
    }
    if (!navigator.onLine) {
      loadFromCache();
      enterDraftMode("離線使用者");
      return;
    }
    isSilentAuth = false;
    tokenClient.requestAccessToken({ prompt: 'select_account' });
  });

  // ====================================================
  // OAuth 授權回呼
  // ====================================================
  async function handleTokenResponse(response) {
    if (response.error) {
      console.warn("[Auth] 授權回應:", response.error, response.error_description);
      if (!isSilentAuth) {
        alert("Google 登入失敗：" + (response.error_description || response.error));
      }
      isSilentAuth = false;
      pendingDraftAfterAuth = null;
      return;
    }

    accessToken = response.access_token;
    const expiresIn = parseInt(response.expires_in, 10) || 3600;
    const expiresAt = Date.now() + (expiresIn - 60) * 1000;
    localStorage.setItem("google_access_token", accessToken);
    localStorage.setItem("google_token_expires_at", expiresAt.toString());
    console.log("[Auth] 已取得存取權杖 (靜默模式:", isSilentAuth, ", 效期:", expiresIn, "秒)");

    if (!isSilentAuth) {
      loadingOverlay.classList.remove("hidden");
    }

    try {
      userProfile = await fetchUserProfile();
      console.log("[Auth] 使用者：", userProfile.name, "/", userProfile.email);

      // 檢查使用者 Email 是否在管理者設定的白名單內
      const checkResult = await checkWhitelist(userProfile.email);
      if (!checkResult.allowed) {
        accessToken = null;
        pendingDraftAfterAuth = null;
        localStorage.removeItem("google_access_token");
        localStorage.removeItem("google_token_expires_at");
        if (!isSilentAuth) {
          alert(checkResult.msg || "❌ 存取受限：您的帳號尚未通過管理員審核。");
        }
        showLoginSection();
        return;
      }

      const displayName = checkResult.name || userProfile.name || userProfile.email;

      // 儲存登入憑證與身分快取，供下次自動進入使用
      localStorage.setItem("has_logged_in", "true");
      localStorage.setItem("saved_display_name", displayName);
      localStorage.setItem("saved_user_profile", JSON.stringify(userProfile));

      // 若有待處理的草稿（先前因未授權而暫存），立即自動接續送出！
      if (pendingDraftAfterAuth) {
        console.log("[Auth] 偵測到待處理草稿，自動執行上傳...");
        const draftToSend = pendingDraftAfterAuth;
        pendingDraftAfterAuth = null;
        try {
          await uploadDraftToDrive(draftToSend);
          loadingOverlay.classList.add("hidden");
          resetDraftForm();
          draftSection.classList.add("hidden");
          successSection.classList.remove("hidden");
          userInfoBadge.textContent = "👤 " + displayName;
          userInfoBadge.classList.remove("hidden");
          btnSync.classList.remove("hidden");
          alert("✅ Google 帳號授權成功，草稿已自動送出！");
          return;
        } catch (uploadErr) {
          console.error("[Auth] 待處理草稿自動上傳失敗:", uploadErr);
          let drafts = JSON.parse(localStorage.getItem("offlineDrafts") || "[]");
          drafts.push(draftToSend);
          localStorage.setItem("offlineDrafts", JSON.stringify(drafts));
          loadingOverlay.classList.add("hidden");
          resetDraftForm();
          draftSection.classList.add("hidden");
          successSection.classList.remove("hidden");
          alert("⚠️ 授權完成，但草稿上傳雲端失敗（" + uploadErr.message + "）。\n草稿已先安全保存於本機，後續將在背景自動補傳！");
          return;
        }
      }

      // 載入資料（客戶 + 產品 + 庫存）
      await initData();

      // 若尚未進入表單則進入表單
      if (draftSection.classList.contains("hidden")) {
        enterDraftMode(displayName);
      } else {
        // 若已在表單，更新頂部使用者資訊與庫存時間顯示
        userInfoBadge.textContent = "👤 " + displayName;
        userInfoBadge.classList.remove("hidden");
        btnSync.classList.remove("hidden");
        const stockCount = Object.keys(STOCK_MAP).length;
        const lastUpdated = localStorage.getItem("inventory_last_updated");
        updateAllInventoryTimeDisplays(lastUpdated);
        if (!isSilentAuth) {
          alert(`✅ 登入與資料同步完成！\n\n• 客戶資料：${MOCK_CUSTOMERS.length} 筆\n• 產品項目：${MOCK_PRODUCTS.length} 筆\n• 庫存報表：${stockCount} 筆`);
        }
      }

    } catch (err) {
      console.error("[Auth] 登入後初始化失敗:", err);
      if (!isSilentAuth) {
        alert("資料載入失敗，請重新整理後再試。\n錯誤：" + err.message);
      }
    } finally {
      loadingOverlay.classList.add("hidden");
      isSilentAuth = false;
    }
  }

  // ====================================================
  // 檢查白名單權限 (呼叫 GAS check_whitelist)
  // ====================================================
  async function checkWhitelist(email) {
    if (!email) return { allowed: false, msg: "無效的使用者帳號" };
    try {
      const res = await fetch(`${GAS_URL}?action=check_whitelist&email=${encodeURIComponent(email)}`);
      if (!res.ok) {
        console.warn("[Auth] GAS 白名單檢查 HTTP 錯誤:", res.status);
        // 連線異常時，若有本機快取可允許離線使用
        return { allowed: true };
      }
      const data = await res.json();
      if (data.status === "ok") {
        return { allowed: true, name: data.name };
      } else if (data.status === "rejected") {
        return { allowed: false, msg: data.msg };
      }
      return { allowed: false, msg: data.msg || "驗證失敗" };
    } catch(err) {
      console.warn("[Auth] 白名單連線檢查異常，離線模式允許存取:", err);
      return { allowed: true };
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
    userInfoBadge.textContent = "👤 " + displayName;
    userInfoBadge.classList.remove("hidden");
    btnSync.classList.remove("hidden");

    loginSection.classList.add("hidden");
    draftSection.classList.remove("hidden");
    successSection.classList.add("hidden");

    itemsContainer.innerHTML = "";
    itemCount = 0;
    addBlankItem();

    // 顯示庫存更新時間
    const lastUpdated = localStorage.getItem("inventory_last_updated");
    updateAllInventoryTimeDisplays(lastUpdated);
  }

  function updateAllInventoryTimeDisplays(timeStr) {
    document.querySelectorAll(".inventory-time-text").forEach(el => {
      el.textContent = timeStr || "待同步";
    });
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
      if (tokenClient) {
        isSilentAuth = false;
        tokenClient.requestAccessToken({ prompt: 'select_account' });
      } else {
        alert("尚未完成 Google 授權，正在為您切換至登入畫面。");
        showLoginSection();
      }
      return;
    }
    loadingOverlay.classList.remove("hidden");
    await initData();
    loadingOverlay.classList.add("hidden");
    const stockCount = Object.keys(STOCK_MAP).length;
    const lastUpdated = localStorage.getItem("inventory_last_updated");
    updateAllInventoryTimeDisplays(lastUpdated);
    alert(`✅ 資料同步完成！\n\n• 客戶資料：${MOCK_CUSTOMERS.length} 筆\n• 產品項目：${MOCK_PRODUCTS.length} 筆\n• 庫存報表：${stockCount} 筆`);
  });

  // ====================================================
  // 強制清除快取並重新載入按鈕
  // ====================================================
  const btnClearCache = document.getElementById("btnClearCache");
  if (btnClearCache) {
    btnClearCache.addEventListener("click", async () => {
      const confirmClear = confirm("確定要強制清除本機所有快取（包含 Service Worker 與快取資料）並重新載入最新版本嗎？");
      if (!confirmClear) return;

      loadingOverlay.classList.remove("hidden");
      try {
        // 1. 註銷所有 Service Worker
        if ('serviceWorker' in navigator) {
          const registrations = await navigator.serviceWorker.getRegistrations();
          for (let reg of registrations) {
            await reg.unregister();
            console.log('[快取清理] Service Worker 已註銷');
          }
        }
        // 2. 刪除所有 CacheStorage 快取儲存庫
        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
          console.log('[快取清理] CacheStorage 已全數清空');
        }
        // 3. 清空 localStorage 快取資料與登入記錄
        localStorage.removeItem("products_cache");
        localStorage.removeItem("customers_cache");
        localStorage.removeItem("inventory_cache");
        localStorage.removeItem("inventory_last_updated");
        localStorage.removeItem("has_logged_in");
        localStorage.removeItem("saved_display_name");
        localStorage.removeItem("saved_user_profile");
        localStorage.removeItem("google_access_token");
        localStorage.removeItem("google_token_expires_at");
        localStorage.removeItem("cached_backup_folder_id");
        accessToken = null;
        userProfile = null;
        pendingDraftAfterAuth = null;
        console.log('[快取清理] localStorage 快取與登入狀態已全數清空');

        // 4. 加入時間戳記突破所有瀏覽器與代理快取
        window.location.href = window.location.pathname + '?t=' + Date.now();
      } catch (err) {
        console.error('[快取清理] 清除失敗:', err);
        window.location.reload();
      }
    });
  }

  // ====================================================
  // 取得或建立「報價系統備份」資料夾 (Google Drive REST API)
  // ====================================================
  async function getOrCreateBackupFolderId() {
    if (!accessToken) {
      throw new Error("尚未取得有效的 Google 授權憑證");
    }

    // 優先使用已快取的資料夾 ID
    const cachedFolderId = localStorage.getItem("cached_backup_folder_id");
    if (cachedFolderId) {
      return cachedFolderId;
    }

    const folderQuery = encodeURIComponent(
      `name='${BACKUP_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
    );
    const searchRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${folderQuery}&spaces=drive&fields=files(id,name)`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!searchRes.ok) {
      if (searchRes.status === 401) {
        accessToken = null;
        localStorage.removeItem("google_access_token");
        localStorage.removeItem("google_token_expires_at");
        throw new Error("Google 登入憑證已過期 (401)");
      }
      const errText = await searchRes.text();
      throw new Error(`查詢雲端資料夾失敗 (${searchRes.status})：${errText.substring(0, 100)}`);
    }
    const searchData = await searchRes.json();
    if (searchData.files && searchData.files.length > 0) {
      const foundId = searchData.files[0].id;
      localStorage.setItem("cached_backup_folder_id", foundId);
      return foundId;
    }

    // 若資料夾不存在，前端直接透過 Drive API 建立
    const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: BACKUP_FOLDER_NAME,
        mimeType: "application/vnd.google-apps.folder"
      })
    });
    if (!createRes.ok) {
      if (createRes.status === 401) {
        accessToken = null;
        localStorage.removeItem("google_access_token");
        localStorage.removeItem("google_token_expires_at");
        throw new Error("Google 登入憑證已過期 (401)");
      }
      const errText = await createRes.text();
      throw new Error(`建立雲端資料夾失敗 (${createRes.status})：${errText.substring(0, 100)}`);
    }
    const createData = await createRes.json();
    localStorage.setItem("cached_backup_folder_id", createData.id);
    return createData.id;
  }

  // ====================================================
  // 直連 Google Drive API 上傳草稿 JSON 檔案
  // ====================================================
  async function uploadDraftToDrive(draftData) {
    if (!accessToken) {
      throw new Error("尚未取得有效的 Google 授權憑證");
    }

    const folderId = await getOrCreateBackupFolderId();
    const timestamp = Date.now();
    const uuid = Math.random().toString(36).substring(2, 10);
    const fileName = `draft_${timestamp}_${uuid}.json`;

    draftData.draft_id = fileName;
    const fileContent = JSON.stringify(draftData, null, 2);

    const boundary = "-------314159265358979323846";
    const delimiter = "\r\n--" + boundary + "\r\n";
    const close_delim = "\r\n--" + boundary + "--";

    const metadata = {
      name: fileName,
      mimeType: "application/json",
      parents: [folderId]
    };

    const multipartRequestBody =
      delimiter +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      JSON.stringify(metadata) +
      delimiter +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      fileContent +
      close_delim;

    const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`
      },
      body: multipartRequestBody
    });

    if (!res.ok) {
      if (res.status === 401) {
        accessToken = null;
        localStorage.removeItem("google_access_token");
        localStorage.removeItem("google_token_expires_at");
        throw new Error("Google 登入憑證已過期 (401)");
      }
      if (res.status === 404) {
        localStorage.removeItem("cached_backup_folder_id");
      }
      const errText = await res.text();
      throw new Error(`Google Drive 上傳失敗 (${res.status})：${errText.substring(0, 150)}`);
    }

    return await res.json();
  }

  // ====================================================
  // 同步本機離線暫存草稿至 Google Drive
  // ====================================================
  async function syncOfflineDraftsToDrive() {
    if (!accessToken || !navigator.onLine) return;
    const offlineDrafts = JSON.parse(localStorage.getItem("offlineDrafts") || "[]");
    if (offlineDrafts.length === 0) return;

    console.log(`[Sync] 正在上傳 ${offlineDrafts.length} 筆離線草稿至 Google Drive...`);
    const remaining = [];
    for (const draft of offlineDrafts) {
      try {
        await uploadDraftToDrive(draft);
      } catch (err) {
        console.error("[Sync] 離線草稿上傳失敗:", err);
        remaining.push(draft);
      }
    }
    localStorage.setItem("offlineDrafts", JSON.stringify(remaining));
    if (remaining.length < offlineDrafts.length) {
      console.log(`[Sync] 成功上傳 ${offlineDrafts.length - remaining.length} 筆離線草稿！`);
    }
  }

  // ====================================================
  // 初始化雲端資料載入
  // ====================================================
  async function initData() {
    await Promise.allSettled([
      loadCustomersFromDrive(),
      loadProductsFromDrive(),
      loadInventoryFromGAS(),
      syncOfflineDraftsToDrive()
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
    }
  }

  // ====================================================
  // 從業務員個人 Google Drive 讀取產品資料
  // 路徑：報價系統備份 / products.json
  // 若找不到個人備份檔或讀取失敗，自動降級調用 loadProductsFromGAS()
  // 依據架構規範：庫存狀態一律不讀取個人硬碟，維持由公司 GAS 即時查詢
  // ====================================================
  async function loadProductsFromDrive() {
    if (!accessToken) {
      await loadProductsFromGAS();
      return;
    }
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
        console.warn("[Drive] 找不到「報價系統備份」資料夾，降級使用 GAS 公司產品庫");
        await loadProductsFromGAS();
        return;
      }

      const folderId = folders[0].id;

      // Step 2：搜尋 products.json
      const fileQuery = encodeURIComponent(
        `name='${PRODUCTS_FILE_NAME}' and '${folderId}' in parents and trashed=false`
      );
      const fileRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${fileQuery}&spaces=drive&fields=files(id,name,modifiedTime)`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!fileRes.ok) {
        const errText = await fileRes.text();
        throw new Error(`Drive API 錯誤 ${fileRes.status}：${errText.substring(0, 150)}`);
      }
      const fileData = await fileRes.json();
      const files = fileData.files || [];

      if (files.length === 0) {
        console.warn("[Drive] 找不到個人 products.json，自動降級載入 GAS 公司產品庫");
        await loadProductsFromGAS();
        return;
      }

      const fileId = files[0].id;

      // Step 3：下載檔案內容
      const downloadRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!downloadRes.ok) throw new Error("下載失敗：" + downloadRes.status);

      const personalProducts = await downloadRes.json();
      if (Array.isArray(personalProducts) && personalProducts.length > 0) {
        MOCK_PRODUCTS = personalProducts;
        localStorage.setItem("products_cache", JSON.stringify(MOCK_PRODUCTS));
        console.log("[Drive] 個人產品資料同步成功，共", MOCK_PRODUCTS.length, "筆");
      } else {
        console.warn("[Drive] 個人產品檔案為空，降級使用 GAS 公司產品庫");
        await loadProductsFromGAS();
      }

    } catch (e) {
      console.error("[Drive] 讀取個人產品資料失敗，降級使用 GAS 公司產品庫:", e);
      await loadProductsFromGAS();
    }
  }

  // ====================================================
  // 從 GAS 代理讀取產品資料
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
  // 從 GAS 代理讀取庫存對照表（L廠庫存數量報表）
  // ====================================================
  async function loadInventoryFromGAS() {
    try {
      const res = await fetch(`${GAS_URL}?action=get_inventory`);
      const data = await res.json();
      if (data.status === "ok" && data.data) {
        STOCK_MAP = data.data;
        localStorage.setItem("inventory_cache", JSON.stringify(STOCK_MAP));
        if (data.last_updated) {
          localStorage.setItem("inventory_last_updated", data.last_updated);
          updateAllInventoryTimeDisplays(data.last_updated);
        }
        console.log("[GAS] 庫存同步成功，共", Object.keys(STOCK_MAP).length, "筆");
      } else {
        console.warn("[GAS] 庫存讀取異常:", data.msg);
        STOCK_MAP = JSON.parse(localStorage.getItem("inventory_cache") || "{}");
      }
    } catch(e) {
      console.warn("[GAS] 庫存讀取失敗（使用離線快取）:", e.message);
      STOCK_MAP = JSON.parse(localStorage.getItem("inventory_cache") || "{}");
    }
  }

  // ====================================================
  // 查詢某產品型號的實際庫存數量 (多重純化比對)
  // ====================================================
  let isStockMapLoaded = false;
  function ensureStockMapLoaded() {
    if (!isStockMapLoaded) {
      if (!STOCK_MAP || typeof STOCK_MAP !== 'object' || Object.keys(STOCK_MAP).length === 0) {
        try {
          STOCK_MAP = JSON.parse(localStorage.getItem("inventory_cache") || "{}");
        } catch(e) {}
      }
      isStockMapLoaded = true;
    }
  }

  function getStockQty(code) {
    if (!code) return null;
    ensureStockMapLoaded();
    if (!STOCK_MAP) return null;

    const raw = String(code).trim().toLowerCase();
    if (STOCK_MAP[raw] !== undefined) return STOCK_MAP[raw];

    const noParen = String(code).replace(/[（(].*?[)）]/g, "").trim().toLowerCase();
    if (STOCK_MAP[noParen] !== undefined) return STOCK_MAP[noParen];

    const alphaNum = String(code).replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    if (STOCK_MAP[alphaNum] !== undefined) return STOCK_MAP[alphaNum];

    return null;
  }

  // ====================================================
  // 客戶選擇對話框 (Modal) 邏輯
  // ====================================================
  customerNameInput.addEventListener("click", () => {
    customerModalCount.textContent = MOCK_CUSTOMERS.length;
    customerModalSearch.value = "";
    renderCustomerModal(MOCK_CUSTOMERS);
    customerModal.classList.remove("hidden");
    setTimeout(() => customerModalSearch.focus(), 100);
  });

  btnCloseCustomerModal.addEventListener("click", () => {
    customerModal.classList.add("hidden");
  });

  let customerDebounceTimer = null;
  let isCustomerComposing = false;

  customerModalSearch.addEventListener("compositionstart", () => {
    isCustomerComposing = true;
  });

  customerModalSearch.addEventListener("compositionend", (e) => {
    isCustomerComposing = false;
    filterCustomers(e.target.value);
  });

  customerModalSearch.addEventListener("input", (e) => {
    if (isCustomerComposing) return;
    clearTimeout(customerDebounceTimer);
    customerDebounceTimer = setTimeout(() => {
      filterCustomers(e.target.value);
    }, 200);
  });

  function filterCustomers(keyword) {
    const val = (keyword || "").trim().toLowerCase();
    if (!val) {
      renderCustomerModal(MOCK_CUSTOMERS);
      return;
    }
    const matches = [];
    for (let i = 0; i < MOCK_CUSTOMERS.length; i++) {
      const c = MOCK_CUSTOMERS[i];
      let name = "";
      let taxId = "";
      let phone = "";
      let addr = "";
      let hasContactMatch = false;

      if (typeof c === 'string') {
        name = c.toLowerCase();
      } else {
        name = String(c.name || "").toLowerCase();
        taxId = String(c.tax_id || "").toLowerCase();
        phone = String(c.phone || "").toLowerCase();
        addr = String(c.address || "").toLowerCase();
        hasContactMatch = Array.isArray(c.contacts) && c.contacts.some(ct => {
          const ctName = String(ct.name || "").toLowerCase();
          const ctPhone = String(ct.phone || "").toLowerCase();
          const ctEmail = String(ct.email || "").toLowerCase();
          return ctName.includes(val) || ctPhone.includes(val) || ctEmail.includes(val);
        });
      }

      if (!name.includes(val) && !taxId.includes(val) && !phone.includes(val) && !addr.includes(val) && !hasContactMatch) {
        continue;
      }

      let priority = 9;
      if (name.startsWith(val)) {
        priority = 1;
      } else if (name.includes(val)) {
        priority = 2;
      } else if (taxId.startsWith(val) || phone.startsWith(val)) {
        priority = 3;
      } else {
        priority = 4;
      }

      matches.push({ customer: c, priority, name });
    }

    matches.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.name.localeCompare(b.name, 'zh-Hant');
    });

    renderCustomerModal(matches.map(m => m.customer));
  }

  function renderCustomerModal(customers) {
    if (!customers || customers.length === 0) {
      customerModalResults.innerHTML = `<div class="text-center text-muted mt-3">找不到符合的客戶資料</div>`;
      return;
    }

    customerModalResults.innerHTML = customers.map(c => {
      const name = typeof c === 'string' ? c : (c.name || "");
      let subInfo = "";
      if (typeof c === 'object' && c.contacts && c.contacts.length > 0) {
        subInfo = c.contacts.map(ct => `聯絡人: ${ct.name}${ct.phone ? ` (${ct.phone})` : ''}`).join(" | ");
      } else if (typeof c === 'object' && c.phone) {
        subInfo = `電話: ${c.phone}`;
      }

      return `
        <div class="customer-item" data-name="${name}">
          <div class="customer-item-name">${name}</div>
          ${subInfo ? `<div class="customer-item-sub">${subInfo}</div>` : ""}
        </div>
      `;
    }).join("");
  }

  customerModalResults.addEventListener("click", (e) => {
    const item = e.target.closest(".customer-item");
    if (item && item.dataset.name) {
      const customer = MOCK_CUSTOMERS.find(c => (c.name || c) === item.dataset.name);
      if (customer && typeof customer === 'object') {
        const contact = customer.contacts && customer.contacts[0] ? customer.contacts[0].name : "";
        customerNameInput.value = contact ? `${customer.name} - ${contact}` : customer.name;
        customerNameInput.dataset.company = customer.name || "";
        customerNameInput.dataset.contact = contact || "";
        
        document.getElementById("customerDetailCard").classList.remove("hidden");
        document.getElementById("customerDetailSummary").textContent = `${customer.name} - ${contact}`;
        document.getElementById("cdCompany").textContent = customer.name || "";
        document.getElementById("cdTaxId").textContent = customer.tax_id || "";
        document.getElementById("cdContact").textContent = contact;
        document.getElementById("cdPhone").textContent = customer.phone || "";
        document.getElementById("cdAddress").textContent = customer.address || "";
      } else {
        customerNameInput.value = item.dataset.name;
        customerNameInput.dataset.company = item.dataset.name || "";
        customerNameInput.dataset.contact = "";
        document.getElementById("customerDetailCard").classList.add("hidden");
      }
      customerModal.classList.add("hidden");
    }
  });

  const btnToggleCustomerDetail = document.getElementById("btnToggleCustomerDetail");
  if (btnToggleCustomerDetail) {
    btnToggleCustomerDetail.addEventListener("click", () => {
      const body = document.getElementById("customerDetailBody");
      if (body.classList.contains("hidden")) {
        body.classList.remove("hidden");
        btnToggleCustomerDetail.textContent = "▲";
      } else {
        body.classList.add("hidden");
        btnToggleCustomerDetail.textContent = "▼";
      }
    });
  }

  function refreshItemIndices() {
    const itemRows = itemsContainer.querySelectorAll('.item-row');
    itemRows.forEach((row, idx) => {
      const badge = row.querySelector('.item-index-badge');
      if (badge) {
        badge.textContent = `#${idx + 1}`;
      }
    });
    const draftItemBadge = document.getElementById('draftItemBadge');
    if (draftItemBadge) {
      draftItemBadge.textContent = `共 ${itemRows.length} 項`;
    }
  }

  function calculateTotal() {
    let total = 0;
    const itemRows = document.querySelectorAll('.item-row');
    itemRows.forEach(row => {
      const finalPriceInput = row.querySelector('.final-price-field');
      if (finalPriceInput && finalPriceInput.value) {
        total += parseFloat(finalPriceInput.value.replace(/[^0-9.-]+/g, "")) || 0;
      }
    });
    const totalAmountEl = document.getElementById('totalAmount');
    if (totalAmountEl) {
      totalAmountEl.textContent = total.toLocaleString();
    }
  }

  // ====================================================
  // 交期 / 備註選擇對話框 (Modal) 邏輯
  // ====================================================
  const PRESET_DELIVERY_OPTIONS = [
    "交期待確認",
    "目前現貨",
    "下單後1~3個工作天",
    "下單後3~5個工作天",
    "下單後5~7個工作天",
    "下單後1~2週",
    "下單後2~3週",
    "下單後3~4週",
    "下單後1~2個月",
    "下單後2~3個月",
    "下單後3~4個月",
    "下單後4~5個月",
    "下單後5~6個月",
    "下單後6~8個月",
    "下單後8~10個月",
    "下單後10~12個月",
    "標準交期2個月以上，若有需求建議較早下單。",
    "標準交期3個月以上，若有需求建議較早下單。",
    "標準交期4個月以上，若有需求建議較早下單。",
    "標準交期5個月以上，若有需求建議較早下單。",
    "標準交期6個月以上，若有需求建議較早下單。"
  ];

  function openDeliveryModal(itemId) {
    currentEditingDeliveryItemId = itemId;
    const currentInput = document.getElementById(`${itemId}-delivery`);
    const currentVal = currentInput ? currentInput.value.trim() : "";
    if (customDeliveryInput) customDeliveryInput.value = currentVal;
    renderDeliveryModal(currentVal);
    if (deliveryModal) deliveryModal.classList.remove("hidden");
  }

  function closeDeliveryModal() {
    if (deliveryModal) deliveryModal.classList.add("hidden");
    currentEditingDeliveryItemId = null;
  }

  function renderDeliveryModal(selectedVal) {
    if (!deliveryModalResults) return;
    deliveryModalResults.innerHTML = PRESET_DELIVERY_OPTIONS.map(opt => {
      const isSel = opt === selectedVal;
      return `
        <div class="delivery-item ${isSel ? 'selected' : ''}" data-value="${opt}">
          ${opt}
        </div>
      `;
    }).join("");
  }

  if (btnCloseDeliveryModal) {
    btnCloseDeliveryModal.addEventListener("click", closeDeliveryModal);
  }

  if (deliveryModal) {
    deliveryModal.addEventListener("click", (e) => {
      if (e.target === deliveryModal) {
        closeDeliveryModal();
      }
    });
  }

  if (deliveryModalResults) {
    deliveryModalResults.addEventListener("click", (e) => {
      const item = e.target.closest(".delivery-item");
      if (item && item.dataset.value && currentEditingDeliveryItemId) {
        const targetInput = document.getElementById(`${currentEditingDeliveryItemId}-delivery`);
        if (targetInput) {
          targetInput.value = item.dataset.value;
        }
        closeDeliveryModal();
      }
    });
  }

  if (btnConfirmCustomDelivery) {
    btnConfirmCustomDelivery.addEventListener("click", () => {
      if (!currentEditingDeliveryItemId) return;
      const targetInput = document.getElementById(`${currentEditingDeliveryItemId}-delivery`);
      if (targetInput && customDeliveryInput) {
        targetInput.value = customDeliveryInput.value.trim();
      }
      closeDeliveryModal();
    });
  }

  if (customDeliveryInput) {
    customDeliveryInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (btnConfirmCustomDelivery) btnConfirmCustomDelivery.click();
      }
    });
  }

  // ====================================================
  // 新增品項（2x2 欄位直接呈現）
  // ====================================================
  function addBlankItem() {
    itemCount++;
    const itemId = `item-${itemCount}`;
    const lastUpdated = localStorage.getItem("inventory_last_updated") || "";
    const updateTimeStr = lastUpdated ? lastUpdated : "待同步";
    const currentCount = itemsContainer.querySelectorAll('.item-row').length + 1;
    const itemHTML = `
      <div class="item-row" id="${itemId}">
        <div class="item-header">
          <span class="item-index-badge">#${currentCount}</span>
          <button type="button" class="product-picker-input" id="${itemId}-title" style="flex:1;">
            點擊選擇產品...
          </button>
          <button type="button" class="item-remove" onclick="document.getElementById('${itemId}').remove(); setTimeout(() => { calculateTotal(); refreshItemIndices(); }, 50);">&times;</button>
        </div>
        <div class="item-grid">
          <div>
            <label id="${itemId}-stock-label">庫存數量</label>
            <input type="text" id="${itemId}-stock-qty" placeholder="-" readonly class="field-readonly stock-field">
          </div>
          <div>
            <label>經銷價(未稅)</label>
            <input type="text" id="${itemId}-dealer-price" placeholder="-" readonly class="field-readonly price-field">
          </div>

          <div class="stock-disclaimer-box">
            <div class="stock-disclaimer-time">
              <span>🕒 庫存更新時間：</span><strong class="inventory-time-text">${updateTimeStr}</strong>
            </div>
            <div class="stock-disclaimer-text">
              ⚠️ 庫存非即時數量，若庫存數量偏低或屬大手案件，請再次查詢確認實際庫存。
            </div>
          </div>

          <div>
            <label>建議折數(%)</label>
            <input type="number" name="suggested_discount" id="${itemId}-sug-discount" placeholder="輸入折數" step="any">
          </div>
          <div>
            <label>建議報價(元)</label>
            <input type="number" name="suggested_price" id="${itemId}-sug-price" placeholder="輸入報價" step="any">
          </div>
          <div>
            <label>需求數量</label>
            <input type="number" name="quantity" id="${itemId}-qty" min="1" value="1" required>
          </div>
          <div>
            <label>最終售價(元)</label>
            <input type="text" id="${itemId}-final-price" placeholder="-" readonly class="field-readonly final-price-field">
          </div>
        </div>
        <div class="item-delivery">
          <label>交期 / 備註</label>
          <input type="text" name="delivery_time" id="${itemId}-delivery"
            placeholder="點擊選擇交期 / 備註..."
            readonly
            style="cursor:pointer; background:#ffffff;">
        </div>
        <input type="hidden" name="item_code" id="${itemId}-code">
        <input type="hidden" name="item_name" id="${itemId}-name">
      </div>
    `;
    itemsContainer.insertAdjacentHTML('beforeend', itemHTML);
    refreshItemIndices();

    const deliveryInput = document.getElementById(`${itemId}-delivery`);
    if (deliveryInput) {
      deliveryInput.addEventListener("click", () => {
        openDeliveryModal(itemId);
      });
    }

    const sugPriceInput = document.getElementById(`${itemId}-sug-price`);
    const sugDiscountInput = document.getElementById(`${itemId}-sug-discount`);
    const dealerPriceInput = document.getElementById(`${itemId}-dealer-price`);
    const qtyInput = document.getElementById(`${itemId}-qty`);
    const finalPriceInput = document.getElementById(`${itemId}-final-price`);

    function updateFinalPrice() {
      const sp = parseFloat(sugPriceInput.value);
      const q = parseInt(qtyInput.value) || 0;
      if (!isNaN(sp) && q > 0) {
        finalPriceInput.value = Math.round(sp * q).toLocaleString();
      } else {
        finalPriceInput.value = "";
      }
      calculateTotal();
    }

    sugPriceInput.addEventListener("input", (e) => {
      const sp = parseFloat(e.target.value);
      const dpStr = dealerPriceInput.value.replace(/[^0-9.]/g, '');
      const dp = parseFloat(dpStr);
      if (!isNaN(sp) && !isNaN(dp) && dp > 0) {
        const discount = (sp / dp) * 100;
        sugDiscountInput.value = discount.toFixed(2);
      } else {
        sugDiscountInput.value = "";
      }
      updateFinalPrice();
    });

    sugDiscountInput.addEventListener("input", (e) => {
      const disc = parseFloat(e.target.value);
      const dpStr = dealerPriceInput.value.replace(/[^0-9.]/g, '');
      const dp = parseFloat(dpStr);
      if (!isNaN(disc) && !isNaN(dp)) {
        const sp = dp * (disc / 100);
        sugPriceInput.value = Math.round(sp);
      } else {
        sugPriceInput.value = "";
      }
      updateFinalPrice();
    });

    qtyInput.addEventListener("input", updateFinalPrice);

    const removeBtn = document.querySelector(`#${itemId} .item-remove`);
    if(removeBtn) {
      removeBtn.addEventListener("click", () => {
        setTimeout(() => {
          calculateTotal();
          refreshItemIndices();
        }, 50);
      });
    }

    // 搜尋對話框觸發事件
    const titleEl = document.getElementById(`${itemId}-title`);
    titleEl.addEventListener("click", () => {
      currentEditingItemIndex = itemId;
      selectedProductCode = null;
      selectedProductName = null;
      const title = document.getElementById("productModalTitle");
      if (title) title.textContent = "選擇產品";
      if (btnConfirmProduct) {
        btnConfirmProduct.textContent = "確認選擇";
        btnConfirmProduct.classList.add("hidden");
      }

      productModal.classList.remove("hidden");
      productSearch.value = "";
      performProductFilter("");
      setTimeout(() => productSearch.focus(), 100);
    });
  }

  btnAddItem.addEventListener("click", addBlankItem);

  // 快速查價 / 庫存按鈕
  const btnQuickSearch = document.getElementById("btnQuickSearch");
  if (btnQuickSearch) {
    btnQuickSearch.addEventListener("click", () => {
      currentEditingItemIndex = null;
      selectedProductCode = null;
      selectedProductName = null;
      const title = document.getElementById("productModalTitle");
      if (title) title.textContent = "🔍 快速查價 / 查庫存";
      if (btnConfirmProduct) {
        btnConfirmProduct.textContent = "➕ 加入報價草稿";
        btnConfirmProduct.classList.add("hidden");
      }

      productModal.classList.remove("hidden");
      productSearch.value = "";
      performProductFilter("");
      setTimeout(() => productSearch.focus(), 100);
    });
  }

  // ====================================================
  // 產品選擇 Modal（防抖 250ms + 分批加載 50 筆 + 滾動加載）
  // ====================================================
  const PRODUCT_PAGE_SIZE = 50;
  let currentProductMatches = [];
  let renderedProductCount = 0;
  let productDebounceTimer = null;
  let isProductComposing = false;

  btnCloseModal.addEventListener("click", () => productModal.classList.add("hidden"));

  // 輸入法合成事件監聽（防止中文注音/拼音組字時頻繁計算）
  productSearch.addEventListener("compositionstart", () => {
    isProductComposing = true;
  });

  productSearch.addEventListener("compositionend", (e) => {
    isProductComposing = false;
    performProductFilter(e.target.value);
  });

  productSearch.addEventListener("input", (e) => {
    if (isProductComposing) return;
    clearTimeout(productDebounceTimer);
    productDebounceTimer = setTimeout(() => {
      performProductFilter(e.target.value);
    }, 250);
  });

  function performProductFilter(keyword) {
    const val = (keyword || "").trim().toLowerCase();
    if (!val) {
      currentProductMatches = MOCK_PRODUCTS;
      resetAndRenderProducts();
      return;
    }

    const tokens = val.split(/\s+/).filter(Boolean);
    const matches = [];

    for (let i = 0; i < MOCK_PRODUCTS.length; i++) {
      const p = MOCK_PRODUCTS[i];
      const code = (p.code || "").toLowerCase();
      const name = (p.name || "").toLowerCase();

      // 檢查是否符合所有搜尋關鍵字詞 (AND 關係)
      let isMatch = true;
      for (let t = 0; t < tokens.length; t++) {
        if (!code.includes(tokens[t]) && !name.includes(tokens[t])) {
          isMatch = false;
          break;
        }
      }
      if (!isMatch) continue;

      // 計算搜尋權重優先級（數字越小越優先）
      let priority = 99;

      if (code === val) {
        // 第一順位：型號完全符合
        priority = 1;
      } else if (code.startsWith(val)) {
        // 第二順位：型號首字母/前綴完全符合（例如搜尋 SA3，SA3-043-0.75K 排在最前）
        priority = 2;
      } else if (tokens.length > 1 && code.startsWith(tokens[0])) {
        // 第三順位：多詞搜尋時，型號首字母符合第一個詞
        priority = 3;
      } else if (code.includes("-" + tokens[0]) || code.includes("/" + tokens[0]) || code.includes("_" + tokens[0])) {
        // 第四順位：型號內部單字開頭符合（如分隔符號後接關鍵字）
        priority = 4;
      } else if (code.includes(tokens[0])) {
        // 第五順位：型號中間任意位置包含
        priority = 5;
      } else if (name.startsWith(val) || name.startsWith(tokens[0])) {
        // 第六順位：規格名稱開頭符合
        priority = 6;
      } else {
        // 第七順位：其他模糊相關搜尋（僅在規格說明或附帶文字中提及，例如配件卡備註）
        priority = 7;
      }

      matches.push({ product: p, priority, codeLength: code.length, code });
    }

    // 依優先順序排序：首字母開頭者絕對優先，模糊相符者排在後面
    matches.sort((a, b) => {
      // 1. 優先順位（首字母開始者排在最前）
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      // 2. 相同順位時，型號長度較短者優先（精確度高）
      if (a.codeLength !== b.codeLength) {
        return a.codeLength - b.codeLength;
      }
      // 3. 英數字自然排序
      return a.code.localeCompare(b.code, undefined, { numeric: true, sensitivity: 'base' });
    });

    currentProductMatches = matches.map(m => m.product);
    resetAndRenderProducts();
  }

  function resetAndRenderProducts() {
    selectedProductCode = null;
    selectedProductName = null;
    if (btnConfirmProduct) btnConfirmProduct.classList.add("hidden");

    renderedProductCount = 0;
    productResults.innerHTML = "";
    productResults.scrollTop = 0;

    if (!currentProductMatches || currentProductMatches.length === 0) {
      productResults.innerHTML = `<div class="text-center text-muted mt-3">找不到符合的產品</div>`;
      return;
    }

    appendNextProductBatch();
  }

  function buildProductItemHTML(p) {
    const qty = getStockQty(p.code);
    let stockBadge = "";
    if (qty !== null && qty > 0) {
      stockBadge = `<span class="stock-badge stock-in">現貨 ${qty}</span>`;
    }

    const dealerPrice = p.dealer_price ? `<span style="color:var(--primary-color);">經銷 $${Number(p.dealer_price).toLocaleString()}</span>` : "";
    const listPrice   = p.list_price   ? `<span style="color:var(--text-muted);">定價 $${Number(p.list_price).toLocaleString()}</span>`   : "";
    const priceLine   = (dealerPrice || listPrice)
      ? `<div style="font-size:0.8rem; display:flex; gap:10px; margin-top:3px;">${dealerPrice}${listPrice}</div>`
      : "";

    return `
      <div class="product-item" data-code="${p.code || ''}" data-name="${p.name || ''}">
        <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
          <strong>${p.code || ''}</strong>
          ${stockBadge}
        </div>
        <div style="color:var(--text-muted); font-size:0.875rem;">${p.name || ''}</div>
        ${priceLine}
      </div>
    `;
  }

  function appendNextProductBatch() {
    if (!currentProductMatches || renderedProductCount >= currentProductMatches.length) return;

    const existingLoader = document.getElementById("productLoadingIndicator");
    if (existingLoader) existingLoader.remove();

    const nextBatch = currentProductMatches.slice(renderedProductCount, renderedProductCount + PRODUCT_PAGE_SIZE);
    renderedProductCount += nextBatch.length;

    const html = nextBatch.map(buildProductItemHTML).join("");
    productResults.insertAdjacentHTML("beforeend", html);

    if (renderedProductCount < currentProductMatches.length) {
      const moreHTML = `
        <div id="productLoadingIndicator" class="text-center text-muted" style="padding:12px; font-size:0.8rem;">
          向下滑動載入更多 (${renderedProductCount} / ${currentProductMatches.length})
        </div>
      `;
      productResults.insertAdjacentHTML("beforeend", moreHTML);
    } else if (currentProductMatches.length > PRODUCT_PAGE_SIZE) {
      const endHTML = `
        <div id="productLoadingIndicator" class="text-center text-muted" style="padding:12px; font-size:0.8rem;">
          已顯示全部 ${currentProductMatches.length} 筆產品
        </div>
      `;
      productResults.insertAdjacentHTML("beforeend", endHTML);
    }
  }

  // 監聽滾動事件以觸發下一批次載入
  productResults.addEventListener("scroll", () => {
    if (productResults.scrollTop + productResults.clientHeight >= productResults.scrollHeight - 80) {
      appendNextProductBatch();
    }
  });

  productResults.addEventListener("click", (e) => {
    const item = e.target.closest(".product-item");
    if (item) {
      const allItems = productResults.querySelectorAll(".product-item");
      allItems.forEach(el => el.classList.remove("selected"));
      
      item.classList.add("selected");
      selectedProductCode = item.dataset.code;
      selectedProductName = item.dataset.name;
      
      if (btnConfirmProduct) btnConfirmProduct.classList.remove("hidden");
    }
  });

  if (btnConfirmProduct) {
    btnConfirmProduct.addEventListener("click", () => {
      if (!selectedProductCode) return;

      let targetItemId = currentEditingItemIndex;
      if (!targetItemId) {
        // 若在快速查價模式下點擊加入，自動新增一列品項
        addBlankItem();
        targetItemId = `item-${itemCount}`;
      }

      const code = selectedProductCode;
      const name = selectedProductName;
      const productObj = MOCK_PRODUCTS.find(p => p.code === code) || {};
      
      const qty = getStockQty(code);
      let stockStr = "";
      if (qty !== null) {
        stockStr = String(qty);
      } else {
        stockStr = "-";
      }
      
      const dPrice = productObj.dealer_price ? `$${Number(productObj.dealer_price).toLocaleString()}` : "未定";
      
      // 更新 product-picker-input 顯示內容
      const titleField = document.getElementById(`${targetItemId}-title`);
      if (titleField) {
        titleField.textContent = code;
        titleField.classList.add("selected");
      }
      const codeField = document.getElementById(`${targetItemId}-code`);
      if (codeField) codeField.value = code;
      const nameField = document.getElementById(`${targetItemId}-name`);
      if (nameField) nameField.value = name;
      
      // 直接填入 2x2 介面欄位
      const dPriceEl = document.getElementById(`${targetItemId}-dealer-price`);
      if (dPriceEl) dPriceEl.value = dPrice;
      
      const stockEl = document.getElementById(`${targetItemId}-stock-qty`);
      if (stockEl) {
        stockEl.value = stockStr;
        stockEl.style.color = (qty !== null && qty > 0) || productObj.stock === "IN_STOCK" ? "#059669" : "#dc2626";
      }
      
      productModal.classList.add("hidden");
    });
  }

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
      const sugPrice = row.querySelector("input[name='suggested_price']").value;
      const sugDiscount = row.querySelector("input[name='suggested_discount']").value;
      const deliveryTime = row.querySelector("input[name='delivery_time']")?.value || "";
      if (!code) {
        hasError = true;
      } else {
        items.push({ 
          code, 
          name, 
          quantity: parseInt(qty), 
          suggested_price: parseFloat(sugPrice) || null,
          suggested_discount: parseFloat(sugDiscount) || null,
          delivery_time: deliveryTime || null
        });
      }
    });

    if (hasError) {
      alert("請確實選擇產品品項。");
      return;
    }

    const compName = customerNameInput.dataset.company || (customer.includes(" - ") ? customer.split(" - ")[0].trim() : customer);
    const contName = customerNameInput.dataset.contact || (customer.includes(" - ") ? customer.split(" - ")[1].trim() : "");

    const draftData = {
      email:     userProfile ? userProfile.email : "unknown",
      name:      userProfile ? (userProfile.name || userProfile.email) : "unknown",
      customer:  customer,
      company:   compName,
      contact:   contName,
      items:     items,
      timestamp: new Date().toISOString()
    };

    if (navigator.onLine) {
      // 檢查 Google 授權憑證是否有效
      if (!isTokenValid()) {
        console.log("[Draft] Google 憑證無效或已過期，暫存草稿並啟動授權...");
        pendingDraftAfterAuth = draftData;
        if (tokenClient) {
          isSilentAuth = false;
          tokenClient.requestAccessToken({ prompt: 'select_account' });
        } else {
          alert("尚未完成 Google 授權，請先登入。");
          showLoginSection();
        }
        return; // 優雅中斷，等待授權完成後自動接續上傳，不跳出失敗視窗！
      }

      loadingOverlay.classList.remove("hidden");
      try {
        await uploadDraftToDrive(draftData);
        loadingOverlay.classList.add("hidden");
        resetDraftForm();
        draftSection.classList.add("hidden");
        successSection.classList.remove("hidden");
      } catch (err) {
        loadingOverlay.classList.add("hidden");
        console.error("[Draft] 送出草稿失敗:", err);
        // 若雲端上傳失敗，自動暫存至離線草稿佇列，確保使用者輸入不遺失
        let drafts = JSON.parse(localStorage.getItem("offlineDrafts") || "[]");
        drafts.push(draftData);
        localStorage.setItem("offlineDrafts", JSON.stringify(drafts));
        alert("⚠️ 雲端傳輸異常（" + err.message + "）。\n草稿已安全保存於手機本機，系統將在背景自動補傳！");
        resetDraftForm();
        draftSection.classList.add("hidden");
        successSection.classList.remove("hidden");
      }
    } else {
      let drafts = JSON.parse(localStorage.getItem("offlineDrafts") || "[]");
      drafts.push(draftData);
      localStorage.setItem("offlineDrafts", JSON.stringify(drafts));
      resetDraftForm();
      draftSection.classList.add("hidden");
      successSection.classList.remove("hidden");
    }
  });

  function resetDraftForm() {
    customerNameInput.value = "";
    const card = document.getElementById("customerDetailCard");
    if (card) card.classList.add("hidden");
    itemsContainer.innerHTML = "";
    itemCount = 0;
    addBlankItem();
    calculateTotal();
  }

  btnNewDraft.addEventListener("click", () => {
    resetDraftForm();
    successSection.classList.add("hidden");
    draftSection.classList.remove("hidden");
  });

  // ====================================================
  // LINE 報價生成與預覽對話框
  // ====================================================
  function generateLineQuoteText() {
    const itemRows = itemsContainer.querySelectorAll(".item-row");
    const resultBlocks = [];

    itemRows.forEach(row => {
      const code = row.querySelector("input[name='item_code']")?.value || "";
      const name = row.querySelector("input[name='item_name']")?.value || "";
      if (!code) return; // 未選取產品的行跳過

      const qty         = row.querySelector("input[name='quantity']")?.value || "1";
      const sugPrice     = row.querySelector("input[name='suggested_price']")?.value || "";
      const deliveryTime = row.querySelector("input[name='delivery_time']")?.value || "";

      let priceStr = "-";
      if (sugPrice) {
        const priceNum = parseFloat(sugPrice);
        if (!isNaN(priceNum)) priceStr = priceNum.toLocaleString();
      }

      const deliveryStr = deliveryTime.trim() || "待確認";

      const block = [
        `產品：\t${code}`,
        `規格：\t${name}`,
        `數量：\t${qty}\tEA`,
        `貴司入手單價： ${priceStr} \t元(未稅)`,
        `交期：\t${deliveryStr}`
      ].join("\n");
      resultBlocks.push(block);
    });

    return resultBlocks.join("\n\n");
  }

  if (btnLineQuote) {
    btnLineQuote.addEventListener("click", () => {
      const itemRows = itemsContainer.querySelectorAll(".item-row");
      const hasProduct = Array.from(itemRows).some(row =>
        row.querySelector("input[name='item_code']")?.value
      );
      if (!hasProduct) {
        alert("請先選取至少一個品項產品再複製報價。");
        return;
      }
      const text = generateLineQuoteText();
      lineQuoteText.value = text;
      lineModal.classList.remove("hidden");
      setTimeout(() => lineQuoteText.focus(), 100);
    });
  }

  function closeLineModal() {
    lineModal.classList.add("hidden");
  }

  if (btnCloseLineModal) btnCloseLineModal.addEventListener("click", closeLineModal);
  if (btnCancelLineQuote) btnCancelLineQuote.addEventListener("click", closeLineModal);

  // 點擊背景關閉 LINE Modal
  lineModal.addEventListener("click", (e) => {
    if (e.target === lineModal) closeLineModal();
  });

  if (btnCopyLineQuote) {
    btnCopyLineQuote.addEventListener("click", async () => {
      const text = lineQuoteText.value;
      let copied = false;

      // 方法 1：現代 Clipboard API (HTTPS 環境)
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          copied = true;
        } catch (e) {
          console.warn("[LINE] clipboard.writeText 失敗，嘗試舊方法", e);
        }
      }

      // 方法 2：舊式 execCommand fallback (HTTP/舊瀏覽器)
      if (!copied) {
        try {
          lineQuoteText.select();
          document.execCommand("copy");
          copied = true;
        } catch (e) {
          console.warn("[LINE] execCommand copy 失敗", e);
        }
      }

      if (copied) {
        const orig = btnCopyLineQuote.textContent;
        btnCopyLineQuote.textContent = "✅ 已複製！";
        btnCopyLineQuote.style.backgroundColor = "#059669";
        setTimeout(() => {
          closeLineModal();
          btnCopyLineQuote.textContent = orig;
          btnCopyLineQuote.style.backgroundColor = "";
        }, 800);
      } else {
        alert("自動複製失敗，請長按文字區域手動全選後複製。");
      }
    });
  }

}); // end DOMContentLoaded
