// ====================================================
// 系統設定
// ====================================================
const GAS_URL = "https://script.google.com/macros/s/AKfycbx48PMWVPysN9gd4OcPq1JmzqkRzwu494C2jFxK71Al13Q4Lr2y5KP3RbS80pgs8CYxGg/exec";
const WEB_CLIENT_ID = "668571991428-ffjs6ud0apusi7akb0lmptae24qqtbto.apps.googleusercontent.com";
const DRIVE_SCOPES = "https://www.googleapis.com/auth/drive.file profile email";
const BACKUP_FOLDER_NAME = "報價系統備份";
const CUSTOMERS_FILE_NAME = "customers.json";
const PRODUCTS_FILE_NAME = "products.json";
const SETTINGS_FILE_NAME = "settings.json";

// 庫存對照表：產品型號(小寫) → 可用數量（從 L廠庫存試算表同步）
let STOCK_MAP = {};
// 純化索引：去除連字號/斜線後的純英數 key → 可用數量（對齊電腦版 normalize_for_matching 邏輯）
let NORM_STOCK_MAP = {};

// ====================================================
// 全域狀態
// ====================================================
let MOCK_CUSTOMERS = [];
let MOCK_PRODUCTS = [];
let FINANCE_SETTINGS = {
  tax_rate: 5,
  round_digit: 1,
  round_factor: 10,
  round_method: "ROUND",
  customer_sort_mode: "FAVORITE_FIRST"
};
let tokenClient = null;
let accessToken = null;
let userProfile = null;
let pendingDraftAfterAuth = null;
let isTestMode = false;

// 檢查是否為本地/區網測試環境
function isTestEnvironment() {
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host.startsWith("192.168.") || host.startsWith("172.") || host.startsWith("10.") || host.endsWith(".local");
}

function isTokenValid() {
  if (!accessToken) return false;
  const exp = parseInt(localStorage.getItem("google_token_expires_at") || "0", 10);
  return Date.now() < exp;
}

document.addEventListener("DOMContentLoaded", () => {
  // 🚀 版本自動同步與舊快取清理防護 (v 1.71)
  const CURRENT_APP_VERSION = "1.71";
  const appVersionInfo = document.getElementById("appVersionInfo");
  if (appVersionInfo) {
    appVersionInfo.textContent = "v " + CURRENT_APP_VERSION;
  }
  const lastAppVersion = localStorage.getItem("app_version");
  if (lastAppVersion !== CURRENT_APP_VERSION) {
    console.log(`[VersionUpdate] 偵測到版本更新 (${lastAppVersion || "舊版"} -> ${CURRENT_APP_VERSION})，強制清理舊快取`);
    if ('caches' in window) {
      caches.keys().then(keys => {
        keys.forEach(k => {
          if (k !== 'quote-draft-v1.71') {
            caches.delete(k);
          }
        });
      });
    }
    localStorage.removeItem("inventory_cache");
    localStorage.removeItem("products_cache");
    localStorage.removeItem("customers_cache");
    localStorage.setItem("app_version", CURRENT_APP_VERSION);
  }

  let isAutoSyncing = false;

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
    navigator.serviceWorker.register('./sw.js?v=1.71')
      .then(reg => {
        console.log('[PWA] Service Worker 已註冊 (v 1.71)', reg);
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
    setupAdminImpersonator();

    // 🚀 選項 A 智慧自動更新：啟動時在背景非同步連線 GAS 更新最新庫存與雲端資料
    triggerBackgroundAutoSync();
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
        localStorage.removeItem("is_admin_user");
        if (adminImpersonateBar) adminImpersonateBar.classList.add("hidden");
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
  // 🚀 選項 A 智慧自動更新機制：背景同步庫存與雲端資料
  // ====================================================
  async function triggerBackgroundAutoSync() {
    if (!navigator.onLine || isAutoSyncing) return;
    isAutoSyncing = true;
    console.log("[AutoSync] 啟動背景非同步庫存更新...");
    try {
      await loadInventoryFromGAS();
      const updated = localStorage.getItem("inventory_last_updated");
      updateAllInventoryTimeDisplays(updated);
      console.log("[AutoSync] 庫存自動更新成功，最新時間：", updated);
    } catch (err) {
      console.warn("[AutoSync] 背景庫存更新失敗（維持本機快取）：", err);
    } finally {
      isAutoSyncing = false;
    }

    // 若 Access Token 仍有效，同步非同步更新個人客戶、產品與財務設定
    if (isTokenValid()) {
      Promise.allSettled([
        loadCustomersFromDrive(),
        loadProductsFromDrive(),
        loadSettingsFromDrive(),
        syncOfflineDraftsToDrive()
      ]).then(() => {
        console.log("[AutoSync] 個人雲端資料背景更新完成");
      }).catch(err => {
        console.warn("[AutoSync] 個人雲端資料背景更新異常:", err);
      });
    }
  }

  // 檢查是否需要因跨日或超過 1 小時而自動重新整理庫存
  async function checkAndRefreshInventoryIfNeeded() {
    if (!navigator.onLine) return;
    const lastUpdatedStr = localStorage.getItem("inventory_last_updated") || "";
    const now = new Date();
    const todayMMdd = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;

    let needsUpdate = false;
    if (!lastUpdatedStr) {
      needsUpdate = true;
    } else if (!lastUpdatedStr.startsWith(todayMMdd)) {
      // 跨日了！
      needsUpdate = true;
    } else {
      const lastSyncTs = parseInt(localStorage.getItem("inventory_last_sync_timestamp") || "0", 10);
      if (Date.now() - lastSyncTs > 60 * 60 * 1000) {
        needsUpdate = true;
      }
    }

    if (needsUpdate) {
      console.log(`[AutoSync] 偵測到庫存資料已跨日或過期 (${lastUpdatedStr})，自動在背景更新...`);
      await triggerBackgroundAutoSync();
    }
  }

  // 監聽手機螢幕開啟與切回畫面事件 (喚醒時跨日檢查)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      checkAndRefreshInventoryIfNeeded();
    }
  });
  window.addEventListener("focus", () => {
    checkAndRefreshInventoryIfNeeded();
  });

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

    // 若本機已有登入紀錄且非測試隔離環境，背景自動嘗試靜默續期
    if (hasLoggedIn && navigator.onLine && !isTestEnvironment()) {
      console.log("[Auth] 背景執行靜默續期 Google 授權...");
      isSilentAuth = true;
      try {
        tokenClient.requestAccessToken({ prompt: 'none' });
      } catch (e) {
        console.warn("[Auth] 靜默續期呼叫失敗:", e);
        isSilentAuth = false;
      }
    } else if (isTestEnvironment()) {
      console.log("[Auth] 測試環境：略過 Google 授權靜默續期以避免 origin_mismatch (400)");
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
        localStorage.removeItem("is_admin_user");
        if (adminImpersonateBar) adminImpersonateBar.classList.add("hidden");
        if (!isSilentAuth) {
          alert(checkResult.msg || "❌ 存取受限：您的帳號尚未通過管理員審核。");
        }
        showLoginSection();
        return;
      }

      // 👑 授權最高管理員 Google 帳號自動啟用 (tsengweisung@gmail.com 或後端 is_admin: true)
      const userEmail = (userProfile.email || "").trim().toLowerCase();
      const isAdmin = (userEmail === "tsengweisung@gmail.com") || (checkResult.is_admin === true);
      if (isAdmin) {
        localStorage.setItem("is_admin_user", "true");
      } else {
        localStorage.removeItem("is_admin_user");
      }

      const displayName = checkResult.name || userProfile.name || userProfile.email;

      // 儲存登入憑證與身分快取，供下次自動進入使用
      localStorage.setItem("has_logged_in", "true");
      localStorage.setItem("saved_display_name", displayName);
      localStorage.setItem("saved_user_profile", JSON.stringify(userProfile));

      setupAdminImpersonator();

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
    if (!email) return { allowed: false, msg: "未提供使用者帳號" };
    const lowerEmail = email.trim().toLowerCase();
    // 👑 管理員本機直接授權放行
    if (lowerEmail === "tsengweisung@gmail.com") {
      return { allowed: true, name: "曾維崧", is_admin: true };
    }
    try {
      const res = await fetch(`${GAS_URL}?action=check_whitelist&email=${encodeURIComponent(lowerEmail)}`);
      if (!res.ok) {
        console.warn("[Auth] GAS 白名單檢查 HTTP 錯誤:", res.status);
        // 連線異常時，若有本機快取可允許離線使用
        return { allowed: true };
      }
      const data = await res.json();
      if (data.status === "ok") {
        return { allowed: true, name: data.name, is_admin: !!data.is_admin };
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

    setupAdminImpersonator();
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
        localStorage.removeItem("is_admin_user");
        if (adminImpersonateBar) adminImpersonateBar.classList.add("hidden");
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
      loadSettingsFromDrive(),
      loadInventoryFromGAS(),
      syncOfflineDraftsToDrive()
    ]);
  }

  // ====================================================
  // 財務計算捨入函式（對齊桌機 PriceCalculator）
  // ====================================================
  function applyRounding(rawPrice) {
    if (isNaN(rawPrice)) return 0;
    const factor = FINANCE_SETTINGS.round_factor || 
      (FINANCE_SETTINGS.round_digit === 1 ? 10 : 
       FINANCE_SETTINGS.round_digit === 2 ? 100 : 
       FINANCE_SETTINGS.round_digit === 3 ? 1000 : 1);
    const method = String(FINANCE_SETTINGS.round_method || "ROUND").toUpperCase();

    const targetVal = rawPrice / factor;
    let roundedVal;
    if (method === "CEIL" || method === "無條件進位") {
      roundedVal = Math.ceil(targetVal - 1e-9);
    } else if (method === "FLOOR" || method === "無條件捨去") {
      roundedVal = Math.floor(targetVal + 1e-9);
    } else {
      roundedVal = Math.round(targetVal);
    }
    return Math.round(roundedVal * factor);
  }

  // ====================================================
  // 取得易讀之捨入位數與捨入方式說明
  // ====================================================
  function getRoundingDesc() {
    let digitStr = "個位數";
    const digit = FINANCE_SETTINGS.round_digit;
    const factor = FINANCE_SETTINGS.round_factor;
    if (digit === 1 || factor === 10) {
      digitStr = "十位數";
    } else if (digit === 2 || factor === 100) {
      digitStr = "百位數";
    } else if (digit === 3 || factor === 1000) {
      digitStr = "千位數";
    } else if (factor && factor > 1) {
      digitStr = `${factor}元`;
    }

    let methodStr = "四捨五入";
    const method = String(FINANCE_SETTINGS.round_method || "").toUpperCase();
    if (method.includes("CEIL") || method.includes("進位")) {
      methodStr = "無條件進位";
    } else if (method.includes("FLOOR") || method.includes("捨去")) {
      methodStr = "無條件捨去";
    }

    return `${digitStr} / ${methodStr}`;
  }

  // 重新整理所有品項的捨入警示標籤文字
  function updateAllRoundingHints() {
    const desc = getRoundingDesc();
    document.querySelectorAll(".field-hint-rounding").forEach(el => {
      el.textContent = `⚠️ 捨入：${desc}`;
    });
  }

  // 依據當前排序模式對客戶清單進行排序
  function sortCustomerList(customers) {
    if (!customers || !Array.isArray(customers)) return customers || [];
    const mode = (FINANCE_SETTINGS && FINANCE_SETTINGS.customer_sort_mode) || "FAVORITE_FIRST";
    return [...customers].sort((a, b) => {
      const aName = typeof a === 'string' ? a : (a.name || "");
      const bName = typeof b === 'string' ? b : (b.name || "");
      if (mode === "QUOTE_COUNT") {
        const aCnt = (typeof a === 'object' && a.quote_count) ? Number(a.quote_count) : 0;
        const bCnt = (typeof b === 'object' && b.quote_count) ? Number(b.quote_count) : 0;
        if (bCnt !== aCnt) return bCnt - aCnt;
        return aName.localeCompare(bName, 'zh-Hant');
      } else if (mode === "NAME_ASC") {
        return aName.localeCompare(bName, 'zh-Hant');
      } else if (mode === "NAME_DESC") {
        return bName.localeCompare(aName, 'zh-Hant');
      } else {
        // 預設模式 1：FAVORITE_FIRST (⭐ 常用客戶優先，其餘按名稱正序)
        const aFav = (typeof a === 'object' && a.is_favorite) ? 1 : 0;
        const bFav = (typeof b === 'object' && b.is_favorite) ? 1 : 0;
        if (bFav !== aFav) return bFav - aFav;
        return aName.localeCompare(bName, 'zh-Hant');
      }
    });
  }

  // ====================================================
  // 從快取讀取（離線模式）
  // ====================================================
  function loadFromCache() {
    try {
      MOCK_CUSTOMERS = JSON.parse(localStorage.getItem("customers_cache") || "[]");
      MOCK_CUSTOMERS = sortCustomerList(MOCK_CUSTOMERS);
      MOCK_PRODUCTS  = JSON.parse(localStorage.getItem("products_cache")  || "[]");
      const cachedSettings = localStorage.getItem("finance_settings");
      if (cachedSettings) {
        FINANCE_SETTINGS = Object.assign(FINANCE_SETTINGS, JSON.parse(cachedSettings));
        updateAllRoundingHints();
        MOCK_CUSTOMERS = sortCustomerList(MOCK_CUSTOMERS);
      }
      console.log("[快取] 客戶:", MOCK_CUSTOMERS.length, "筆 / 產品:", MOCK_PRODUCTS.length, "筆 / 財務設定:", FINANCE_SETTINGS);
    } catch (e) {
      console.error("[快取] 讀取失敗:", e);
    }
  }

  // ====================================================
  // 從業務員個人 Google Drive 讀取財務設定 (settings.json)
  // ====================================================
  async function loadSettingsFromDrive() {
    if (!accessToken) return;
    try {
      const folderQuery = encodeURIComponent(
        `name='${BACKUP_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
      );
      const folderRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${folderQuery}&spaces=drive&fields=files(id,name)`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!folderRes.ok) return;
      const folderData = await folderRes.json();
      const folders = folderData.files || [];
      if (folders.length === 0) return;
      const folderId = folders[0].id;

      const fileQuery = encodeURIComponent(
        `name='${SETTINGS_FILE_NAME}' and '${folderId}' in parents and trashed=false`
      );
      const fileRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${fileQuery}&spaces=drive&fields=files(id,name,modifiedTime)`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!fileRes.ok) return;
      const fileData = await fileRes.json();
      const files = fileData.files || [];
      if (files.length === 0) return;

      const fileId = files[0].id;
      const downloadRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!downloadRes.ok) return;

      const cfg = await downloadRes.json();
      if (cfg && typeof cfg === "object") {
        FINANCE_SETTINGS = Object.assign(FINANCE_SETTINGS, cfg);
        localStorage.setItem("finance_settings", JSON.stringify(FINANCE_SETTINGS));
        updateAllRoundingHints();
        MOCK_CUSTOMERS = sortCustomerList(MOCK_CUSTOMERS);
        console.log("[Drive] 財務設定同步成功:", FINANCE_SETTINGS);
      }
    } catch (e) {
      console.warn("[Drive] 讀取個人財務設定失敗，維持快取設定:", e);
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
      MOCK_CUSTOMERS = sortCustomerList(MOCK_CUSTOMERS);
      localStorage.setItem("customers_cache", JSON.stringify(MOCK_CUSTOMERS));
      console.log("[Drive] 客戶資料同步成功，共", MOCK_CUSTOMERS.length, "筆");

    } catch (e) {
      console.error("[Drive] 讀取客戶資料失敗:", e);
      MOCK_CUSTOMERS = JSON.parse(localStorage.getItem("customers_cache") || "[]");
      MOCK_CUSTOMERS = sortCustomerList(MOCK_CUSTOMERS);
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
        isStockMapLoaded = true;
        buildNormStockMap();
        localStorage.setItem("inventory_cache", JSON.stringify(STOCK_MAP));
        localStorage.setItem("inventory_last_sync_timestamp", Date.now().toString());
        if (data.last_updated) {
          localStorage.setItem("inventory_last_updated", data.last_updated);
          updateAllInventoryTimeDisplays(data.last_updated);
        }
        refreshAllItemStockDisplays();
        console.log("[GAS] 庫存同步成功，共", Object.keys(STOCK_MAP).length, "筆，更新時間：", data.last_updated);
      } else {
        console.warn("[GAS] 庫存讀取異常:", data.msg);
        STOCK_MAP = JSON.parse(localStorage.getItem("inventory_cache") || "{}");
      }
    } catch(e) {
      console.warn("[GAS] 庫存讀取失敗（使用離線快取）:", e.message);
      STOCK_MAP = JSON.parse(localStorage.getItem("inventory_cache") || "{}");
    }
  }

  // 重新整理畫面上所有既有品項列的庫存數字與顏色狀態
  function refreshAllItemStockDisplays() {
    ensureStockMapLoaded();
    const rows = itemsContainer.querySelectorAll(".item-row");
    rows.forEach(row => {
      const codeInput = row.querySelector("input[name='item_code']");
      if (!codeInput || !codeInput.value) return;
      const code = codeInput.value;
      const qty = getStockQty(code);
      const stockEl = row.querySelector(".stock-field");
      if (stockEl) {
        if (qty !== null && qty > 0) {
          stockEl.value = `${qty} 台`;
          stockEl.style.color = "#059669";
        } else if (qty === 0) {
          stockEl.value = "無庫存";
          stockEl.style.color = "#dc2626";
        } else {
          stockEl.value = "未納管";
          stockEl.style.color = "#6b7280";
        }
      }
    });
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
      buildNormStockMap();
      isStockMapLoaded = true;
    }
  }

  /**
   * 純化比對字串（對齊電腦版 InventoryService.normalize_for_matching）：
   * 1. 去除含中文字的備註括號（如 (訂購品)），保留機能仕樣括號（如 (C)）
   * 2. 移除所有非英數與小數點字符（連字號、斜線、空白等一律移除）
   * 3. 轉小寫
   * 效果：SA3-043-90K/110K-F → sa3043-90k110kf == SA3-043-90K/110KF 純化結果
   */
  function normalizeForMatching(str) {
    if (!str) return '';
    // 第一層：去除含中文字之備註括號
    let t = String(str).replace(/[（(][^）)]*[\u4e00-\u9fa5]+[^）)]*[)）]/g, '').trim();
    // 第二層：僅保留英數與小數點（移除連字號 [-]、斜線 [/]、空白等）
    t = t.replace(/[^a-zA-Z0-9.]/g, '');
    return t.toLowerCase();
  }

  /**
   * 依據當前 STOCK_MAP 建立純化索引 NORM_STOCK_MAP，
   * 供 getStockQty 第三層 fallback 使用。
   */
  function buildNormStockMap() {
    NORM_STOCK_MAP = {};
    if (!STOCK_MAP || typeof STOCK_MAP !== 'object') return;
    for (const key in STOCK_MAP) {
      const normKey = normalizeForMatching(key);
      // 若同一純化 key 已存在，不覆蓋（先入為主，避免誤蓋）
      if (normKey && NORM_STOCK_MAP[normKey] === undefined) {
        NORM_STOCK_MAP[normKey] = STOCK_MAP[key];
      }
    }
  }

  function getStockQty(code) {
    if (!code) return null;
    ensureStockMapLoaded();
    if (!STOCK_MAP) return null;

    // 第一層：原始小寫精確比對
    const raw = String(code).trim().toLowerCase();
    if (STOCK_MAP[raw] !== undefined) return STOCK_MAP[raw];

    // 第二層：去除中文備註括號後再比對（保留機能仕樣如 (C)）
    const noChineseRemark = String(code).replace(/[（(][^）)]*[\u4e00-\u9fa5]+[^）)]*[)）]/g, '').trim().toLowerCase();
    if (noChineseRemark && STOCK_MAP[noChineseRemark] !== undefined) return STOCK_MAP[noChineseRemark];

    // 第三層：純化比對（對齊電腦版 normalize_for_matching，移除連字號與斜線）
    // 例：SA3-043-90K/110K-F → sa3043-90k110kf，可比對到 SA3-043-90K/110KF
    const normCode = normalizeForMatching(code);
    if (normCode && NORM_STOCK_MAP[normCode] !== undefined) return NORM_STOCK_MAP[normCode];

    return null;
  }

  // ====================================================
  // 客戶選擇對話框 (Modal) 邏輯
  // ====================================================
  customerNameInput.addEventListener("click", () => {
    MOCK_CUSTOMERS = sortCustomerList(MOCK_CUSTOMERS);
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

  // HTML 特殊字元轉義輔助函式
  function escapeHTML(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function filterCustomers(keyword) {
    const val = (keyword || "").trim().toLowerCase();
    if (!val) {
      MOCK_CUSTOMERS = sortCustomerList(MOCK_CUSTOMERS);
      customerModalCount.textContent = MOCK_CUSTOMERS.length;
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
          const ctPhone = String(ct.phone || ct.mobile || "").toLowerCase();
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

    customerModalCount.textContent = matches.length;
    renderCustomerModal(matches.map(m => m.customer));
  }

  function renderCustomerModal(customers) {
    if (!customers || customers.length === 0) {
      customerModalResults.innerHTML = `<div class="text-center text-muted mt-3">找不到符合的客戶資料</div>`;
      return;
    }

    const htmlParts = [];

    customers.forEach(c => {
      if (typeof c === 'string') {
        htmlParts.push(`
          <div class="customer-item" data-name="${escapeHTML(c)}">
            <div class="customer-item-name">${escapeHTML(c)}</div>
          </div>
        `);
        return;
      }

      const name = c.name || "";
      const idStr = (c.id !== undefined && c.id !== null) ? String(c.id) : "";
      const taxId = c.tax_id || "";
      const address = c.address || "";
      const companyPhone = c.phone || "";

      if (Array.isArray(c.contacts) && c.contacts.length > 0) {
        c.contacts.forEach(ct => {
          const contactName = ct.name || "";
          const contactPhone = ct.mobile || ct.phone || "";
          let subInfo = `聯絡人: ${contactName}`;
          if (contactPhone) {
            subInfo += ` (${contactPhone})`;
          }

          htmlParts.push(`
            <div class="customer-item" 
                 data-id="${escapeHTML(idStr)}" 
                 data-name="${escapeHTML(name)}"
                 data-contact="${escapeHTML(contactName)}"
                 data-phone="${escapeHTML(contactPhone || companyPhone)}"
                 data-tax-id="${escapeHTML(taxId)}"
                 data-address="${escapeHTML(address)}">
              <div class="customer-item-name">${escapeHTML(name)}</div>
              <div class="customer-item-sub">${escapeHTML(subInfo)}</div>
            </div>
          `);
        });
      } else {
        const subInfo = companyPhone ? `電話: ${companyPhone}` : (taxId ? `統編: ${taxId}` : "");
        htmlParts.push(`
          <div class="customer-item" 
               data-id="${escapeHTML(idStr)}" 
               data-name="${escapeHTML(name)}"
               data-contact=""
               data-phone="${escapeHTML(companyPhone)}"
               data-tax-id="${escapeHTML(taxId)}"
               data-address="${escapeHTML(address)}">
            <div class="customer-item-name">${escapeHTML(name)}</div>
            ${subInfo ? `<div class="customer-item-sub">${escapeHTML(subInfo)}</div>` : ""}
          </div>
        `);
      }
    });

    customerModalResults.innerHTML = htmlParts.join("");
  }

  customerModalResults.addEventListener("click", (e) => {
    const item = e.target.closest(".customer-item");
    if (!item) return;

    const id = item.dataset.id;
    const name = item.dataset.name || "";
    const contact = item.dataset.contact || "";
    const phone = item.dataset.phone || "";
    const taxId = item.dataset.taxId || "";
    const address = item.dataset.address || "";

    let customer = null;
    if (id) {
      customer = MOCK_CUSTOMERS.find(c => typeof c === 'object' && String(c.id) === String(id));
    }
    if (!customer && name) {
      customer = MOCK_CUSTOMERS.find(c => (c.name || c) === name);
    }

    if (customer && typeof customer === 'object') {
      const selectedContact = contact || (customer.contacts && customer.contacts[0] ? customer.contacts[0].name : "");
      const fullDisplay = selectedContact ? `${customer.name} - ${selectedContact}` : customer.name;

      customerNameInput.value = fullDisplay;
      customerNameInput.dataset.company = customer.name || "";
      customerNameInput.dataset.contact = selectedContact || "";
      customerNameInput.dataset.customerId = customer.id || "";

      document.getElementById("customerDetailCard").classList.remove("hidden");
      document.getElementById("customerDetailSummary").textContent = fullDisplay;
      document.getElementById("cdCompany").textContent = customer.name || "";
      document.getElementById("cdTaxId").textContent = customer.tax_id || taxId || "";
      document.getElementById("cdContact").textContent = selectedContact || "";
      document.getElementById("cdPhone").textContent = customer.phone || phone || "";
      document.getElementById("cdAddress").textContent = customer.address || address || "";
    } else {
      const displayName = contact ? `${name} - ${contact}` : name;
      customerNameInput.value = displayName;
      customerNameInput.dataset.company = name;
      customerNameInput.dataset.contact = contact;
      customerNameInput.dataset.customerId = id || "";

      if (name) {
        document.getElementById("customerDetailCard").classList.remove("hidden");
        document.getElementById("customerDetailSummary").textContent = displayName;
        document.getElementById("cdCompany").textContent = name;
        document.getElementById("cdTaxId").textContent = taxId;
        document.getElementById("cdContact").textContent = contact;
        document.getElementById("cdPhone").textContent = phone;
        document.getElementById("cdAddress").textContent = address;
      } else {
        document.getElementById("customerDetailCard").classList.add("hidden");
      }
    }
    customerModal.classList.add("hidden");
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
        <div class="delivery-item ${isSel ? 'selected' : ''}" data-value="${opt}"
             style="padding:12px 14px; border:1px solid ${isSel ? 'var(--primary-color, #2563eb)' : 'var(--border-color, #e2e8f0)'}; border-radius:8px; background:${isSel ? '#eff6ff' : '#ffffff'}; font-size:0.95rem; font-weight:${isSel ? '600' : 'normal'}; color:${isSel ? 'var(--primary-color, #2563eb)' : 'var(--text-main, #1e293b)'}; cursor:pointer; user-select:none; -webkit-tap-highlight-color:transparent; flex-shrink:0;">
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
          <button type="button" class="item-copy-btn hidden" id="${itemId}-copy-btn" title="複製型號">
            <svg class="icon-copy" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V2zm2-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H6zM2 5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-1h1v1a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1v1H2z"/>
            </svg>
            <svg class="icon-check hidden" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/>
            </svg>
          </button>
          <span id="${itemId}-order-badge" class="order-item-badge hidden">訂購品</span>
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
            <span class="field-hint-rounding">⚠️ 捨入：${getRoundingDesc()}</span>
          </div>
          <div>
            <label>需求數量</label>
            <input type="number" name="quantity" id="${itemId}-qty" min="1" value="1" required>
          </div>
          <div>
            <label>最終售價(元)</label>
            <input type="text" id="${itemId}-final-price" placeholder="-" readonly class="field-readonly final-price-field">
            <span class="field-hint-tax">⚠️ 未稅金額</span>
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
        sugPriceInput.value = applyRounding(sp);
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

    // 🚀 一鍵複製型號按鈕事件 (Win 11 雙層矩形向量圖示)
    const copyBtn = document.getElementById(`${itemId}-copy-btn`);
    if (copyBtn) {
      copyBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const codeInput = document.getElementById(`${itemId}-code`);
        const codeText = codeInput ? codeInput.value : "";
        if (!codeText) return;

        let success = false;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          try {
            await navigator.clipboard.writeText(codeText);
            success = true;
          } catch (err) {
            console.warn("Clipboard API failed, fallback to execCommand", err);
          }
        }
        if (!success) {
          try {
            const tempInput = document.createElement("input");
            tempInput.value = codeText;
            document.body.appendChild(tempInput);
            tempInput.select();
            document.execCommand("copy");
            document.body.removeChild(tempInput);
            success = true;
          } catch (e) {
            console.error("Fallback copy failed", e);
          }
        }

        if (success) {
          copyBtn.classList.add("copied");
          const iconCopy = copyBtn.querySelector(".icon-copy");
          const iconCheck = copyBtn.querySelector(".icon-check");
          if (iconCopy) iconCopy.classList.add("hidden");
          if (iconCheck) iconCheck.classList.remove("hidden");

          setTimeout(() => {
            copyBtn.classList.remove("copied");
            if (iconCopy) iconCopy.classList.remove("hidden");
            if (iconCheck) iconCheck.classList.add("hidden");
          }, 1200);
        }
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

    let orderBadge = "";
    if (p.is_order_item) {
      orderBadge = `<span class="stock-badge stock-order">訂購品</span>`;
    }

    const dealerPrice = p.dealer_price ? `<span style="color:var(--primary-color);">經銷 $${Number(p.dealer_price).toLocaleString()}</span>` : "";
    const listPrice   = p.list_price   ? `<span style="color:var(--text-muted);">定價 $${Number(p.list_price).toLocaleString()}</span>`   : "";
    const priceLine   = (dealerPrice || listPrice)
      ? `<div style="font-size:0.8rem; display:flex; gap:10px; margin-top:3px;">${dealerPrice}${listPrice}</div>`
      : "";

    return `
      <div class="product-item" data-code="${p.code || ''}" data-name="${p.name || ''}">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
          <div style="display:flex; align-items:center; gap:6px;">
            <strong>${p.code || ''}</strong>
            ${orderBadge}
          </div>
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
      
      // 🚀 訂購品標籤更新
      const isOrder = Boolean(productObj.is_order_item);
      const orderBadge = document.getElementById(`${targetItemId}-order-badge`);
      if (orderBadge) {
        if (isOrder) {
          orderBadge.classList.remove("hidden");
        } else {
          orderBadge.classList.add("hidden");
        }
      }
      
      // 🚀 複製按鈕更新 (已選取產品時顯示)
      const copyBtn = document.getElementById(`${targetItemId}-copy-btn`);
      if (copyBtn) {
        copyBtn.classList.remove("hidden");
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
      crm_cases: (typeof selectedCrmCases !== "undefined" && selectedCrmCases.length > 0) ? selectedCrmCases : [],
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
        // 若有綁定 CRM 案件，背景非同步登記關聯紀錄
        if (selectedCrmCases && selectedCrmCases.length > 0) {
          try {
            const rowIndices = selectedCrmCases.map(c => c.row_index).filter(Boolean);
            if (rowIndices.length > 0) {
              const totalAmount = document.getElementById("grandTotal")?.textContent?.replace(/[^\d.]/g, "") || "0";
              fetch(`${GAS_URL}?action=update_crm_quotation_link`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                  quotation_id: `📱外勤草稿 (${compName})`,
                  amount: totalAmount,
                  client_name: compName,
                  case_row_indices: JSON.stringify(rowIndices)
                })
              }).catch(err => console.warn("[CRM Link] 手機草稿關聯 CRM 提示失敗:", err));
            }
          } catch (e) {
            console.warn("[CRM Link] 例外:", e);
          }
        }

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
    customerNameInput.dataset.company = "";
    customerNameInput.dataset.contact = "";
    customerNameInput.dataset.customerId = "";
    const card = document.getElementById("customerDetailCard");
    if (card) card.classList.add("hidden");
    itemsContainer.innerHTML = "";
    itemCount = 0;
    selectedCrmCases = [];
    if (typeof renderSelectedCrmCasesTags === "function") {
      renderSelectedCrmCasesTags();
    }
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

  // ====================================================
  // 📋 OGSM 業務日報模組 (整合於 PWA 外勤手機端)
  // ====================================================

  let currentAppMode = "quote"; // "quote" | "ogsm"
  let ogsmCurrentYear = new Date().getFullYear();
  let ogsmCurrentMonth = new Date().getMonth() + 1; // 1-12
  let ogsmMonthReports = [];
  let ogsmDatesWithReports = new Set();
  let ogsmSyncingReports = []; // 正在背景同步中的日報 (樂觀更新佇列)
  let isOgsmSyncing = false;   // 離線自動補傳互斥鎖

  let toastTimer = null;
  function showToast(message, type = "info") {
    const toast = document.getElementById("ogsmToast");
    if (!toast) return;
    toast.textContent = message;
    toast.className = `ogsm-toast show ${type}`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove("show");
    }, 2800);
  }

  // DOM 元素引用
  const appSwitcherTriggerWrap = document.getElementById("appSwitcherTriggerWrap");
  const appSwitcherTrigger     = document.getElementById("appSwitcherTrigger");
  const appSwitcherDropdown    = document.getElementById("appSwitcherDropdown");
  const appTitleText           = document.getElementById("appTitleText");
  const adminImpersonateBar    = document.getElementById("adminImpersonateBar");
  const adminImpersonateSelect = document.getElementById("adminImpersonateSelect");

  const ogsmSection            = document.getElementById("ogsmSection");
  const ogsmTestBadge          = document.getElementById("ogsmTestBadge");
  const btnPrevMonth           = document.getElementById("btnPrevMonth");
  const btnNextMonth           = document.getElementById("btnNextMonth");
  const btnToday               = document.getElementById("btnToday");
  const currentMonthLabel      = document.getElementById("currentMonthLabel");
  const ogsmCalendarGrid       = document.getElementById("ogsmCalendarGrid");
  const btnNewTodayReport      = document.getElementById("btnNewTodayReport");
  const ogsmSearchInput        = document.getElementById("ogsmSearchInput");
  const btnOgsmSearchClear     = document.getElementById("btnOgsmSearchClear");
  const ogsmSearchResultsPanel = document.getElementById("ogsmSearchResultsPanel");
  const btnCopyLineReport      = document.getElementById("btnCopyLineReport");

  const ogsmDayViewModal       = document.getElementById("ogsmDayViewModal");
  const ogsmDayViewTitle       = document.getElementById("ogsmDayViewTitle");
  const ogsmDayReportList      = document.getElementById("ogsmDayReportList");
  const btnCloseDayViewModal   = document.getElementById("btnCloseDayViewModal");
  const btnAddDayReport        = document.getElementById("btnAddDayReport");

  const ogsmEditModal          = document.getElementById("ogsmEditModal");
  const ogsmEditModalTitle     = document.getElementById("ogsmEditModalTitle");
  const ogsmEditRowIndex       = document.getElementById("ogsmEditRowIndex");
  const ogsmEditOfflineId      = document.getElementById("ogsmEditOfflineId");
  const ogsmHistorySection     = document.getElementById("ogsmHistorySection");
  const ogsmHistoryText        = document.getElementById("ogsmHistoryText");
  const ogsmInputUser          = document.getElementById("ogsmInputUser");
  const ogsmInputDate          = document.getElementById("ogsmInputDate");
  const ogsmInputClient        = document.getElementById("ogsmInputClient");
  const ogsmClientAutocomplete = document.getElementById("ogsmClientAutocomplete");
  const ogsmSelectType         = document.getElementById("ogsmSelectType");
  const ogsmInputContent       = document.getElementById("ogsmInputContent");
  const ogsmInputResult        = document.getElementById("ogsmInputResult");
  const btnCloseOgsmEditModal  = document.getElementById("btnCloseOgsmEditModal");
  const btnCancelOgsmEdit      = document.getElementById("btnCancelOgsmEdit");
  const btnSaveOgsmEdit        = document.getElementById("btnSaveOgsmEdit");

  // 🚀 [Streamlit 對齊] 11 個商機延伸欄位 DOM 物件
  const btnToggleOgsmExtraFields  = document.getElementById("btnToggleOgsmExtraFields");
  const ogsmExtraFieldsBody       = document.getElementById("ogsmExtraFieldsBody");
  const ogsmExtraArrow            = document.getElementById("ogsmExtraArrow");
  const ogsmInputClientOwner      = document.getElementById("ogsmInputClientOwner");
  const ogsmInputIndustry         = document.getElementById("ogsmInputIndustry");
  const ogsmInputChannel          = document.getElementById("ogsmInputChannel");
  const ogsmInputCompChannel      = document.getElementById("ogsmInputCompChannel");
  const ogsmInputActionPlan       = document.getElementById("ogsmInputActionPlan");
  const ogsmInputLostRetrieved    = document.getElementById("ogsmInputLostRetrieved");
  const btnToggleAllOgsmProducts  = document.getElementById("btnToggleAllOgsmProducts");
  const ogsmInputExpectedMonth    = document.getElementById("ogsmInputExpectedMonth");
  const ogsmInputCompetingBrand   = document.getElementById("ogsmInputCompetingBrand");
  const ogsmInputEstimatedAmount  = document.getElementById("ogsmInputEstimatedAmount");
  const ogsmInputDependencies     = document.getElementById("ogsmInputDependencies");

  // 自訂確認與歷史履歷對話框
  const ogsmConfirmModal       = document.getElementById("ogsmConfirmModal");
  const ogsmConfirmMsg         = document.getElementById("ogsmConfirmMsg");
  const btnCancelConfirm       = document.getElementById("btnCancelConfirm");
  const btnExecuteConfirm      = document.getElementById("btnExecuteConfirm");
  const ogsmHistoryModal       = document.getElementById("ogsmHistoryModal");
  const ogsmHistoryModalTitle  = document.getElementById("ogsmHistoryModalTitle");
  const ogsmHistoryModalList   = document.getElementById("ogsmHistoryModalList");
  const btnCloseHistoryModal   = document.getElementById("btnCloseHistoryModal");
  let currentViewingDate = "";

  // 🚀 [新模組變數] CRM 同步、報價單關聯與商機月報 DOM 元件
  const ogsmCrmModal               = document.getElementById("ogsmCrmModal");
  const crmModalSubTitle           = document.getElementById("crmModalSubTitle");
  const crmInputUserName           = document.getElementById("crmInputUserName");
  const crmInputVisitDate          = document.getElementById("crmInputVisitDate");
  const crmInputClientName         = document.getElementById("crmInputClientName");
  const crmInputPurpose            = document.getElementById("crmInputPurpose");
  const crmInputStatusDesc         = document.getElementById("crmInputStatusDesc");
  const crmSelectClientOwner       = document.getElementById("crmSelectClientOwner");
  const crmSelectIndustry          = document.getElementById("crmSelectIndustry");
  const crmSelectChannel           = document.getElementById("crmSelectChannel");
  const crmSelectExpectedMonth     = document.getElementById("crmSelectExpectedMonth");
  const crmInputAmount             = document.getElementById("crmInputAmount");
  const crmSelectBrand             = document.getElementById("crmSelectBrand");
  const crmInputDependencies       = document.getElementById("crmInputDependencies");
  const crmInputCompChannel        = document.getElementById("crmInputCompChannel");
  const crmSelectClientNature      = document.getElementById("crmSelectClientNature");
  const crmSelectLostRetrieved     = document.getElementById("crmSelectLostRetrieved");
  const crmInputActionPlan         = document.getElementById("crmInputActionPlan");
  const btnCloseCrmModal           = document.getElementById("btnCloseCrmModal");
  const btnCancelCrmModal          = document.getElementById("btnCancelCrmModal");
  const btnSubmitCrmModal          = document.getElementById("btnSubmitCrmModal");

  const btnLinkCrmCase             = document.getElementById("btnLinkCrmCase");
  const crmLinkedCasesWrap         = document.getElementById("crmLinkedCasesWrap");
  const crmLinkedCasesList         = document.getElementById("crmLinkedCasesList");
  const btnClearCrmLinks           = document.getElementById("btnClearCrmLinks");
  const crmCaseSelectorModal       = document.getElementById("crmCaseSelectorModal");
  const btnCloseCrmCaseSelector    = document.getElementById("btnCloseCrmCaseSelector");
  const btnCancelCrmCaseSelector   = document.getElementById("btnCancelCrmCaseSelector");
  const btnConfirmCrmCaseSelector  = document.getElementById("btnConfirmCrmCaseSelector");
  const crmCaseSearchInput         = document.getElementById("crmCaseSearchInput");
  const btnCrmLoadHistoryCases     = document.getElementById("btnCrmLoadHistoryCases");
  const crmCaseSelectorList        = document.getElementById("crmCaseSelectorList");
  const crmCaseTierHint            = document.getElementById("crmCaseTierHint");

  const ogsmManagerTeamBadge       = document.getElementById("ogsmManagerTeamBadge");
  const btnOpenMonthlyReportModal  = document.getElementById("btnOpenMonthlyReportModal");
  const monthlyReportModal         = document.getElementById("monthlyReportModal");
  const btnCloseMonthlyReportModal = document.getElementById("btnCloseMonthlyReportModal");
  const monthlyReportDateRangeBtn  = document.getElementById("monthlyReportDateRangeBtn");
  const monthlyReportDateDisplay   = document.getElementById("monthlyReportDateDisplay");
  const monthlyReportStartDate     = document.getElementById("monthlyReportStartDate");
  const monthlyReportEndDate       = document.getElementById("monthlyReportEndDate");
  const monthlyReportMonthPicker   = document.getElementById("monthlyReportMonthPicker"); // 向下相容
  const monthlyReportSalesSelect   = document.getElementById("monthlyReportSalesSelect");
  const btnRefreshMonthlyReport    = document.getElementById("btnRefreshMonthlyReport");
  const crmReportStatusHint        = document.getElementById("crmReportStatusHint");
  const monthlyReportTableBody     = document.getElementById("monthlyReportTableBody");
  const btnExportReportExcel       = document.getElementById("btnExportReportExcel");
  const btnExportReportPdf         = document.getElementById("btnExportReportPdf");

  // 🚀 [新模組變數] OGSM 商機月報 DOM 元件
  const btnOpenOgsmMonthlyReportModal  = document.getElementById("btnOpenOgsmMonthlyReportModal");
  const ogsmMonthlyReportModal         = document.getElementById("ogsmMonthlyReportModal");
  const btnCloseOgsmMonthlyReportModal = document.getElementById("btnCloseOgsmMonthlyReportModal");
  const ogsmReportDateRangeBtn         = document.getElementById("ogsmReportDateRangeBtn");
  const ogsmReportDateDisplay          = document.getElementById("ogsmReportDateDisplay");
  const ogsmReportStartDate            = document.getElementById("ogsmReportStartDate");
  const ogsmReportEndDate              = document.getElementById("ogsmReportEndDate");
  const ogsmReportSalesSelect          = document.getElementById("ogsmReportSalesSelect");
  const btnRefreshOgsmReport           = document.getElementById("btnRefreshOgsmReport");
  const ogsmReportStatusHint           = document.getElementById("ogsmReportStatusHint");
  const ogsmReportTableBody            = document.getElementById("ogsmReportTableBody");
  const btnExportOgsmExcel             = document.getElementById("btnExportOgsmExcel");
  const btnExportOgsmPdf               = document.getElementById("btnExportOgsmPdf");

  // 🚀 桌機版風格浮動月曆 DOM 元件 (RangeCalendarPopup)
  const drpPopup       = document.getElementById("webDateRangePickerPopup");
  const drpPrevBtn     = document.getElementById("drpPrevBtn");
  const drpNextBtn     = document.getElementById("drpNextBtn");
  const drpTitle       = document.getElementById("drpTitle");
  const drpGrid        = document.getElementById("drpGrid");
  const drpStatus      = document.getElementById("drpStatus");
  const drpBtnClear    = document.getElementById("drpBtnClear");
  const drpBtnOk       = document.getElementById("drpBtnOk");

  // 🚀 OGSM 二級修改彈窗 DOM 元件
  const ogsmCaseEditModal              = document.getElementById("ogsmCaseEditModal");
  const btnCloseOgsmCaseEditModal      = document.getElementById("btnCloseOgsmCaseEditModal");
  const btnCancelOgsmCaseEdit          = document.getElementById("btnCancelOgsmCaseEdit");
  const btnSaveOgsmCaseEdit            = document.getElementById("btnSaveOgsmCaseEdit");
  const editOgsmRowIndex               = document.getElementById("editOgsmRowIndex");
  const editOgsmSalesName              = document.getElementById("editOgsmSalesName");
  const editOgsmDate                   = document.getElementById("editOgsmDate");
  const editOgsmSales                  = document.getElementById("editOgsmSales");
  const editOgsmClientName             = document.getElementById("editOgsmClientName");
  const editOgsmClientRating           = document.getElementById("editOgsmClientRating");
  const editOgsmPlanPromotion          = document.getElementById("editOgsmPlanPromotion");
  const editOgsmActualProgress         = document.getElementById("editOgsmActualProgress");

  // 🚀 CRM 直式編輯 Modal DOM 元件
  const crmEditModal               = document.getElementById("crmEditModal");
  const crmEditRowIndex            = document.getElementById("crmEditRowIndex");
  const crmEditClientName          = document.getElementById("crmEditClientName");
  const crmEditClientOwner         = document.getElementById("crmEditClientOwner");
  const crmEditCaseName            = document.getElementById("crmEditCaseName");
  const crmEditProducts            = document.getElementById("crmEditProducts");
  const crmEditExpectedMonth       = document.getElementById("crmEditExpectedMonth");
  const crmEditAmount              = document.getElementById("crmEditAmount");
  const crmEditStatusDesc          = document.getElementById("crmEditStatusDesc");
  const crmEditBrand               = document.getElementById("crmEditBrand");
  const crmEditDependencies        = document.getElementById("crmEditDependencies");
  const crmEditVisitDate           = document.getElementById("crmEditVisitDate");
  const crmEditIndustry            = document.getElementById("crmEditIndustry");
  const crmEditChannel             = document.getElementById("crmEditChannel");
  const crmEditCompChannel         = document.getElementById("crmEditCompChannel");
  const crmEditClientNature        = document.getElementById("crmEditClientNature");
  const crmEditLostRetrieved       = document.getElementById("crmEditLostRetrieved");
  const crmEditActionPlan          = document.getElementById("crmEditActionPlan");
  const crmEditModalTitle          = document.getElementById("crmEditModalTitle");
  const crmEditModalSubtitle       = document.getElementById("crmEditModalSubtitle");
  const btnCloseCrmEditModal       = document.getElementById("btnCloseCrmEditModal");
  const btnCancelCrmEdit           = document.getElementById("btnCancelCrmEdit");
  const btnSaveCrmEdit             = document.getElementById("btnSaveCrmEdit");
  const btnSaveOgsmAndCrm          = document.getElementById("btnSaveOgsmAndCrm");

  // 🚨 客戶跟催清單與自訂門檻 DOM 元件
  const btnOpenFollowUpModal       = document.getElementById("btnOpenFollowUpModal");
  const followUpBadge              = document.getElementById("followUpBadge");
  const followUpModal              = document.getElementById("followUpModal");
  const followUpCount              = document.getElementById("followUpCount");
  const btnCloseFollowUpModal      = document.getElementById("btnCloseFollowUpModal");
  const btnCloseFollowUpFooter     = document.getElementById("btnCloseFollowUpFooter");
  const btnOpenFollowUpSettings    = document.getElementById("btnOpenFollowUpSettings");
  const followUpSearchInput        = document.getElementById("followUpSearchInput");
  const followUpListContainer      = document.getElementById("followUpListContainer");
  const btnFilterFollowUpAll       = document.getElementById("btnFilterFollowUpAll");
  const btnFilterFollowUpRed       = document.getElementById("btnFilterFollowUpRed");
  const btnFilterFollowUpYellow    = document.getElementById("btnFilterFollowUpYellow");
  const filterAllCount             = document.getElementById("filterAllCount");
  const filterRedCount             = document.getElementById("filterRedCount");
  const filterYellowCount          = document.getElementById("filterYellowCount");

  const followUpSettingsModal      = document.getElementById("followUpSettingsModal");
  const btnCloseFollowUpSettings   = document.getElementById("btnCloseFollowUpSettings");
  const btnCancelFollowUpSettings  = document.getElementById("btnCancelFollowUpSettings");
  const btnResetFollowUpSettings   = document.getElementById("btnResetFollowUpSettings");
  const btnSaveFollowUpSettings    = document.getElementById("btnSaveFollowUpSettings");
  const settingDaysA               = document.getElementById("settingDaysA");
  const settingDaysB               = document.getElementById("settingDaysB");
  const settingDaysC               = document.getElementById("settingDaysC");
  const settingDaysDistributor     = document.getElementById("settingDaysDistributor");

  // 🚫 提報不聯繫 DOM 元件
  const noContactModal             = document.getElementById("noContactModal");
  const btnCloseNoContactModal     = document.getElementById("btnCloseNoContactModal");
  const btnCancelNoContact         = document.getElementById("btnCancelNoContact");
  const btnConfirmSubmitNoContact  = document.getElementById("btnConfirmSubmitNoContact");
  const noContactClientTitle       = document.getElementById("noContactClientTitle");
  const noContactClientMeta        = document.getElementById("noContactClientMeta");
  const noContactReasonType        = document.getElementById("noContactReasonType");
  const noContactReasonDesc        = document.getElementById("noContactReasonDesc");

  // 🔄 三大主管轉派覆核 DOM 元件
  const btnOpenReviewModal         = document.getElementById("btnOpenReviewModal");
  const reviewBadge                = document.getElementById("reviewBadge");
  const managerReviewModal         = document.getElementById("managerReviewModal");
  const managerReviewCount         = document.getElementById("managerReviewCount");
  const btnCloseManagerReviewModal = document.getElementById("btnCloseManagerReviewModal");
  const btnCloseManagerReviewFooter= document.getElementById("btnCloseManagerReviewFooter");
  const btnRefreshManagerReview    = document.getElementById("btnRefreshManagerReview");
  const managerReviewListContainer = document.getElementById("managerReviewListContainer");

  // 轉派新業務子對話框 DOM 元件
  const reassignSubModal           = document.getElementById("reassignSubModal");
  const btnCloseReassignSubModal   = document.getElementById("btnCloseReassignSubModal");
  const btnCancelReassignSub       = document.getElementById("btnCancelReassignSub");
  const btnConfirmReassignSub      = document.getElementById("btnConfirmReassignSub");
  const reassignTargetClientName   = document.getElementById("reassignTargetClientName");
  const reassignNewOwnerSelect     = document.getElementById("reassignNewOwnerSelect");
  const reassignManagerNote        = document.getElementById("reassignManagerNote");

  // 報價單當前關聯之 CRM 案件清單 (支援多選)
  let selectedCrmCases = [];
  // 團隊綜合圓點快取字典 (主管模式)
  let ogsmTeamDotsMap = {};
  // 當前 CRM 補填操作之案件物件
  let activeSyncOgsmItem = null;
  // 當前 CRM 編輯來源旗標 ("monthly_report" | "ogsm_save" | null)
  let crmEditSource = null;

  // 🚀 SWR 記憶體快取架構（以日期範圍與業務為鍵值）
  const crmReportCacheMap = new Map();
  const ogsmReportCacheMap = new Map();

  function invalidateMonthlyReportCaches() {
    crmReportCacheMap.clear();
    ogsmReportCacheMap.clear();
    console.log("[Cache] 月報快取已自動失效清洗");
  }

  // HTML 特殊字元轉義輔助函式
  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // 取得當前登入業務員真實姓名 (用於 Google Sheet 分頁對應)
  function getSalesName() {
    const cached = localStorage.getItem("saved_display_name");
    let name = "";
    if (cached && !cached.includes("@")) {
      name = cached.replace(/\s*\(測試\)\s*/g, "").replace(/\s*\(👑\)\s*/g, "").replace(/^👤\s*/, "").replace(/^🧪\s*/, "").trim();
    } else if (userProfile && userProfile.name) {
      name = userProfile.name;
    } else {
      name = "曾仁君";
    }
    if (name === "仁君") name = "曾仁君";
    return name || "曾仁君";
  }

  // 🚀 主管權限判定 (曾仁君、曾維崧、張何達)
  const MANAGER_NAMES = ["曾仁君", "曾維崧", "張何達", "仁君", "維崧", "何達"];
  function isCurrentUserManager() {
    const name = getSalesName();
    return MANAGER_NAMES.some(m => name.includes(m) || m.includes(name));
  }

  // 🚀 標準日期顯示格式化 (例如: 2026/09/24)
  function formatDisplayDate(val) {
    if (!val) return "-";
    const str = String(val).trim();
    if (!str || str === "-") return "-";
    const m = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (m) {
      return `${m[1]}/${m[2].padStart(2, "0")}/${m[3].padStart(2, "0")}`;
    }
    const d = new Date(str);
    if (!isNaN(d.getTime())) {
      const y = d.getFullYear();
      const mNum = String(d.getMonth() + 1).padStart(2, "0");
      const dNum = String(d.getDate()).padStart(2, "0");
      return `${y}/${mNum}/${dNum}`;
    }
    return str;
  }

  // 業務團隊名單 (與雲端試算表「業務日報表_資料庫」分頁名稱 100% 精準對齊)
  let ALL_SALES_MEMBERS = [
    "何宛茹", "張何達", "張書偉", "曾仁君", "曾維崧", "楊家豪", "溫達仁", "莊富丞", "葉仁豪", "謝瑞騏", "邱文輝", "黃柏翰", "黃秀雯"
  ];

  // 組織分組定義
  const DIRECT_SALES_MEMBERS = ["何宛茹", "張書偉", "曾仁君", "楊家豪", "溫達仁", "莊富丞", "黃柏翰"];
  const DEALER_SALES_MEMBERS = ["張何達", "葉仁豪", "邱文輝"];
  // 指定需提醒之經銷商名單（超過 14 天未聯繫提醒；良鴻、松金、紅偉等不提醒）
  const REMINDER_DEALERS = ["赫力", "贊翔", "台瓷", "漢銓"];

  // 預設客戶跟催門檻
  const DEFAULT_FOLLOW_UP_SETTINGS = {
    days_a: 14,
    days_b: 30,
    days_c: 30,
    days_distributor: 14
  };

  function getFollowUpSettings() {
    try {
      const s = localStorage.getItem("follow_up_settings");
      if (s) return Object.assign({}, DEFAULT_FOLLOW_UP_SETTINGS, JSON.parse(s));
    } catch(e) {}
    return Object.assign({}, DEFAULT_FOLLOW_UP_SETTINGS);
  }

  function saveFollowUpSettings(settings) {
    localStorage.setItem("follow_up_settings", JSON.stringify(settings));
  }

  // 智慧客戶分級選項注入器 (直賣組業務僅選 A/B/C；經銷組業務可選 D-A/D-B/D-C 與 A/B/C)
  function populateClientNatureOptions(selectElem, currentVal) {
    if (!selectElem) return;
    const currentSales = getSalesName();
    const isDealer = DEALER_SALES_MEMBERS.indexOf(currentSales) !== -1;
    let options = [];

    if (isDealer) {
      options = [
        { value: "D-A 級（持續大手）", label: "D-A 級 (經銷持續大手 14天)" },
        { value: "D-B 級（前年新客）", label: "D-B 級 (經銷前年新客 30天)" },
        { value: "D-C 級（今年新客/潛在客）", label: "D-C 級 (經銷今年新客 30天)" },
        { value: "A 級（持續大手）", label: "A 級 (直賣持續大手 14天)" },
        { value: "B 級（前年新客）", label: "B 級 (直賣前年新客 30天)" },
        { value: "C 級（今年新客/潛在客）", label: "C 級 (直賣今年新客 30天)" }
      ];
    } else {
      options = [
        { value: "A 級（持續大手）", label: "A 級 (持續大手 14天)" },
        { value: "B 級（前年新客）", label: "B 級 (前年新客 30天)" },
        { value: "C 級（今年新客/潛在客）", label: "C 級 (今年新客/潛在客 30天)" }
      ];
    }

    let extraHtml = "";
    const hasMatch = options.some(o => o.value === currentVal || (currentVal && currentVal.indexOf(o.value.slice(0, 3)) === 0));
    if (currentVal && !hasMatch) {
      extraHtml = `<option value="${currentVal}" selected>${currentVal} (舊資料相容)</option>`;
    }

    selectElem.innerHTML = extraHtml + options.map(o => {
      const isSelected = (currentVal === o.value || (currentVal && currentVal.indexOf(o.value.slice(0, 3)) === 0));
      return `<option value="${o.value}" ${isSelected ? "selected" : ""}>${o.label}</option>`;
    }).join("");
  }

  // ====================================================
  // 👑 管理員身分模擬切換器設置 (tsengweisung@gmail.com 專屬)
  // ====================================================
  function setupAdminImpersonator() {
    if (!adminImpersonateBar || !adminImpersonateSelect) return;
    const pStr = localStorage.getItem("saved_user_profile");
    let profEmail = "";
    try {
      if (pStr) profEmail = (JSON.parse(pStr).email || "").toLowerCase();
    } catch(e) {}
    const isAdmin = localStorage.getItem("is_admin_user") === "true" ||
      (userProfile && userProfile.email && userProfile.email.toLowerCase() === "tsengweisung@gmail.com") ||
      profEmail === "tsengweisung@gmail.com";

    if (isAdmin) {
      adminImpersonateBar.classList.remove("hidden");
      const currentSales = getSalesName();
      adminImpersonateSelect.innerHTML = ALL_SALES_MEMBERS.map(m => {
        const isMgr = MANAGER_NAMES.some(mgr => m.includes(mgr));
        const roleLabel = isMgr ? " (主管)" : "";
        return `<option value="${m}" ${m === currentSales ? "selected" : ""}>👤 ${m}${roleLabel}</option>`;
      }).join("");
      adminImpersonateSelect.value = currentSales;

      if (userInfoBadge) {
        userInfoBadge.textContent = "👤 " + currentSales;
      }
    } else {
      adminImpersonateBar.classList.add("hidden");
    }
  }

  function impersonateSales(targetSales) {
    if (!targetSales) return;
    localStorage.setItem("saved_display_name", targetSales);
    if (userProfile) userProfile.name = targetSales;
    if (userInfoBadge) {
      userInfoBadge.textContent = "👤 " + targetSales;
    }

    // 🚀 切換身分時徹底清理當前記憶體狀態，防止交叉污染
    ogsmMonthReports = [];
    ogsmDatesWithReports = new Set();
    teamDailyCache.clear();
    if (!isCurrentUserManager()) {
      ogsmTeamDotsMap = {};
    }

    // 重新載入行事曆、快取、日報資料與跟催覆核引擎
    loadOgsmLocalCache(ogsmCurrentYear, ogsmCurrentMonth);
    renderCalendar(ogsmCurrentYear, ogsmCurrentMonth);
    loadOgsmMonthly(ogsmCurrentYear, ogsmCurrentMonth);
    refreshFollowUpEngine();

    showToast(`👑 已切換至「${targetSales}」視角進行測試`, "info");
  }

  if (adminImpersonateSelect) {
    adminImpersonateSelect.addEventListener("change", () => {
      const selected = adminImpersonateSelect.value;
      impersonateSales(selected);
    });
  }

  // 初始載入時評估管理員工具列狀態
  setupAdminImpersonator();

  // ====================================================
  // App Switcher 切換選單控制
  // ====================================================
  function toggleAppSwitcher(e) {
    if (e) e.stopPropagation();
    if (!appSwitcherDropdown) return;
    const isHidden = appSwitcherDropdown.classList.contains("hidden");
    if (isHidden) {
      appSwitcherDropdown.classList.remove("hidden");
      if (appSwitcherArrow) appSwitcherArrow.style.transform = "rotate(180deg)";
    } else {
      closeAppSwitcher();
    }
  }

  function closeAppSwitcher() {
    if (appSwitcherDropdown) appSwitcherDropdown.classList.add("hidden");
    if (appSwitcherArrow) appSwitcherArrow.style.transform = "rotate(0deg)";
  }

  if (appSwitcherTrigger) {
    appSwitcherTrigger.addEventListener("click", toggleAppSwitcher);
  }

  // 點擊畫面任意其他空白處關閉選單
  document.addEventListener("click", (e) => {
    if (appSwitcherTriggerWrap && !appSwitcherTriggerWrap.contains(e.target)) {
      closeAppSwitcher();
    }
    if (ogsmClientAutocomplete && !ogsmClientAutocomplete.contains(e.target) && e.target !== ogsmInputClient) {
      ogsmClientAutocomplete.classList.add("hidden");
    }
  });

  // 切換 App (報價擬稿 vs OGSM 日報)
  function switchToApp(mode) {
    currentAppMode = mode;
    document.querySelectorAll("#appSwitcherDropdown .switcher-item").forEach(item => {
      item.classList.toggle("active", item.dataset.app === mode);
    });

    if (mode === "quote") {
      if (appTitleText) appTitleText.textContent = "報價擬稿系統";
      if (ogsmSection) ogsmSection.classList.add("hidden");
      
      const logged = localStorage.getItem("has_logged_in") === "true" || (userProfile && userProfile.email);
      if (logged) {
        if (draftSection) draftSection.classList.remove("hidden");
      } else {
        showLoginSection();
      }
    } else if (mode === "ogsm") {
      if (appTitleText) appTitleText.textContent = "OGSM 業務日報";
      if (draftSection) draftSection.classList.add("hidden");
      if (successSection) successSection.classList.add("hidden");

      const logged = localStorage.getItem("has_logged_in") === "true" || (userProfile && userProfile.email);
      if (logged) {
        if (loginSection) loginSection.classList.add("hidden");
        if (ogsmSection) ogsmSection.classList.remove("hidden");
        // 優先載入本機快取，達成 0 秒瞬間秒開體驗
        loadOgsmLocalCache(ogsmCurrentYear, ogsmCurrentMonth);
        renderCalendar(ogsmCurrentYear, ogsmCurrentMonth);
        loadOgsmMonthly(ogsmCurrentYear, ogsmCurrentMonth);
        refreshFollowUpEngine();
        setupAdminImpersonator();
      } else {
        if (ogsmSection) ogsmSection.classList.add("hidden");
        showLoginSection();
        alert("請先完成登入或點擊快速測試，即可使用 OGSM 業務日報功能。");
      }
    }
    closeAppSwitcher();
  }

  // 監聽選單點擊
  document.querySelectorAll("#appSwitcherDropdown .switcher-item").forEach(item => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      const app = item.dataset.app;
      switchToApp(app);
    });
  });

  // ====================================================
  // 月曆行事曆渲染與導航
  // ====================================================
  function renderCalendar(year, month) {
    if (!ogsmCalendarGrid || !currentMonthLabel) return;
    currentMonthLabel.textContent = `${year} 年 ${month} 月`;

    // 當月第一天是星期幾 (0:週日, 1:週一 ... 6:週六)
    const firstDayIndex = new Date(year, month - 1, 1).getDay();
    // 當月總天數
    const totalDaysInMonth = new Date(year, month, 0).getDate();
    // 上個月總天數
    const prevMonthDays = new Date(year, month - 1, 0).getDate();

    const todayStr = new Date().toISOString().split("T")[0];
    const monthStr = (month < 10 ? "0" : "") + month;

    let gridHtml = "";

    // 1. 上個月的補空格子 (灰底文字)
    for (let i = firstDayIndex - 1; i >= 0; i--) {
      const prevD = prevMonthDays - i;
      gridHtml += `
        <div class="calendar-day other-month">
          <span class="day-number">${prevD}</span>
          <div class="day-dot-container"></div>
        </div>
      `;
    }

    // 2. 當月的日期格子
    if (!currentViewingDate) currentViewingDate = todayStr;

    // 🚀 主管專屬優化：在日曆渲染時，預先在背景靜默預載今日的團隊動態
    if (typeof isCurrentUserManager === "function" && isCurrentUserManager()) {
      if (typeof prefetchTeamDaily === "function") {
        prefetchTeamDaily(todayStr);
      }
    }

    for (let d = 1; d <= totalDaysInMonth; d++) {
      const dayStr = (d < 10 ? "0" : "") + d;
      const fullDateStr = `${year}-${monthStr}-${dayStr}`;
      const isToday = fullDateStr === todayStr;
      const isSelected = fullDateStr === currentViewingDate;

      // 聚合當日所有日報 (雲端正式 + 離線暫存 + 背景同步中)
      const dayOnline = ogsmMonthReports.filter(r => r.date === fullDateStr);
      const dayOffline = getOfflineOgsmDrafts().filter(r => r.date === fullDateStr);
      const daySyncing = ogsmSyncingReports.filter(r => r.date === fullDateStr);

      // 去除重複項目（以識別碼去重）
      const dayReportsMap = new Map();
      [...daySyncing, ...dayOffline, ...dayOnline].forEach(item => {
        const key = item.temp_id || (item.offline_id ? `off_${item.offline_id}` : (item.row_index ? `row_${item.row_index}` : item.client_name));
        dayReportsMap.set(key, item);
      });
      const dayReports = Array.from(dayReportsMap.values());

      let dotHtml = "";
      if (isCurrentUserManager() && ogsmTeamDotsMap[fullDateStr]) {
        // 🚀 主管模式：使用團隊綜合指標 (已排除 5 位豁免人員)
        const teamDotColor = ogsmTeamDotsMap[fullDateStr];
        if (teamDotColor === "blue") {
          dotHtml = `<span class="day-dot dot-blue" title="🔵 全員已完成：全團隊當日拜訪行程皆已回填"></span>`;
        } else if (teamDotColor === "red") {
          dotHtml = `<span class="day-dot dot-red" title="🔴 團隊待回填：有業務人員尚未回填當日實際行程"></span>`;
        }
      } else if (dayReports.length > 0) {
        // 業務個人模式：計算個人日報圓點
        const allCompleted = dayReports.every(r => {
          const hasContent = !!(r.content && String(r.content).trim() !== "");
          const hasResult = !!(r.result && String(r.result).trim() !== "");
          return hasContent && hasResult;
        });

        const hasWorkContent = dayReports.some(r => {
          return !!(r.content && String(r.content).trim() !== "");
        });

        if (allCompleted) {
          dotHtml = `<span class="day-dot dot-blue" title="🔵 已完成：工作內容與實際行程皆已填寫 (${dayReports.length} 筆)"></span>`;
        } else if (hasWorkContent) {
          dotHtml = `<span class="day-dot dot-red" title="🔴 待回填：工作內容已填寫，實際行程待填寫 (${dayReports.length} 筆)"></span>`;
        }
      }

      gridHtml += `
        <div class="calendar-day ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}" data-date="${fullDateStr}">
          <span class="day-number">${d}</span>
          <div class="day-dot-container">
            ${dotHtml}
          </div>
        </div>
      `;
    }

    // 3. 下個月的補空格子 (補足至 35 或 42 格)
    const totalCellsSoFar = firstDayIndex + totalDaysInMonth;
    const targetTotalCells = totalCellsSoFar > 35 ? 42 : 35;
    const remainingCells = targetTotalCells - totalCellsSoFar;

    for (let nextD = 1; nextD <= remainingCells; nextD++) {
      gridHtml += `
        <div class="calendar-day other-month">
          <span class="day-number">${nextD}</span>
          <div class="day-dot-container"></div>
        </div>
      `;
    }

    ogsmCalendarGrid.innerHTML = gridHtml;

    // 綁定日期點擊事件
    ogsmCalendarGrid.querySelectorAll(".calendar-day:not(.other-month)").forEach(cell => {
      cell.addEventListener("click", () => {
        const dateStr = cell.dataset.date;
        if (dateStr) handleDayClick(dateStr);
      });
    });

    // 初次或換月自動渲染當前選中日期的日報清單（預設為今天）
    renderDayReportList(currentViewingDate);
  }

  // ====================================================
  // 本機離線/秒開快取管理 (Instant Cache)
  // ====================================================
  function getOgsmCacheKey(year, month) {
    const salesName = getSalesName() || "default";
    return `ogsm_cache_${salesName}_${year}_${month}`;
  }

  function loadOgsmLocalCache(year, month) {
    try {
      const key = getOgsmCacheKey(year, month);
      const cachedStr = localStorage.getItem(key);
      if (!cachedStr) return false;
      const cached = JSON.parse(cachedStr);
      if (cached && Array.isArray(cached.records)) {
        ogsmMonthReports = cached.records || [];
        ogsmDatesWithReports = new Set(cached.dates || []);

        // 結合本機離線暫存的日期標記
        const offlineList = getOfflineOgsmDrafts();
        offlineList.forEach(item => {
          if (item.date && item.date.startsWith(`${year}-${month < 10 ? '0' : ''}${month}`)) {
            ogsmDatesWithReports.add(item.date);
          }
        });
        console.log(`[OGSM 快取] 已從本機快取秒開載入 ${year}/${month} 共 ${ogsmMonthReports.length} 筆`);
        return true;
      }
    } catch (e) {
      console.warn("[OGSM 快取] 解析快取失敗:", e);
    }
    return false;
  }

  function saveOgsmLocalCache(year, month, records, dates) {
    try {
      const key = getOgsmCacheKey(year, month);
      const dataToStore = {
        updatedAt: Date.now(),
        records: records || [],
        dates: Array.from(dates || [])
      };
      localStorage.setItem(key, JSON.stringify(dataToStore));
    } catch (e) {
      console.warn("[OGSM 快取] 儲存快取失敗:", e);
    }
  }

  // 月份導航事件
  if (btnPrevMonth) {
    btnPrevMonth.addEventListener("click", () => {
      ogsmCurrentMonth--;
      if (ogsmCurrentMonth < 1) {
        ogsmCurrentMonth = 12;
        ogsmCurrentYear--;
      }
      loadOgsmLocalCache(ogsmCurrentYear, ogsmCurrentMonth);
      renderCalendar(ogsmCurrentYear, ogsmCurrentMonth);
      loadOgsmMonthly(ogsmCurrentYear, ogsmCurrentMonth);
    });
  }

  if (btnNextMonth) {
    btnNextMonth.addEventListener("click", () => {
      ogsmCurrentMonth++;
      if (ogsmCurrentMonth > 12) {
        ogsmCurrentMonth = 1;
        ogsmCurrentYear++;
      }
      loadOgsmLocalCache(ogsmCurrentYear, ogsmCurrentMonth);
      renderCalendar(ogsmCurrentYear, ogsmCurrentMonth);
      loadOgsmMonthly(ogsmCurrentYear, ogsmCurrentMonth);
    });
  }

  if (btnToday) {
    btnToday.addEventListener("click", () => {
      const now = new Date();
      ogsmCurrentYear = now.getFullYear();
      ogsmCurrentMonth = now.getMonth() + 1;
      currentViewingDate = now.toISOString().split("T")[0];
      loadOgsmLocalCache(ogsmCurrentYear, ogsmCurrentMonth);
      renderCalendar(ogsmCurrentYear, ogsmCurrentMonth);
      loadOgsmMonthly(ogsmCurrentYear, ogsmCurrentMonth);
    });
  }

  // ====================================================
  // 後端 API：載入當月業務日報
  // ====================================================
  async function loadOgsmMonthly(year, month) {
    const salesName = getSalesName();
    if (!salesName) return;

    try {
      const params = new URLSearchParams({
        action: "get_ogsm_monthly",
        user_name: salesName,
        year: year.toString(),
        month: month.toString(),
        is_test: isTestMode ? "1" : "0"
      });

      const res = await fetch(`${GAS_URL}?${params.toString()}`);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();

      if (data.status === "ok" && Array.isArray(data.records)) {
        ogsmMonthReports = data.records || [];
        ogsmDatesWithReports = new Set(data.dates_with_reports || []);

        // 結合本機離線暫存的日期標記
        const offlineList = getOfflineOgsmDrafts();
        offlineList.forEach(item => {
          if (item.date && item.date.startsWith(`${year}-${month < 10 ? '0' : ''}${month}`)) {
            ogsmDatesWithReports.add(item.date);
          }
        });

        // 成功取得雲端資料後，同步更新本機快取
        saveOgsmLocalCache(year, month, ogsmMonthReports, ogsmDatesWithReports);

        renderCalendar(year, month);
        console.log(`[OGSM] 成功載入 ${year}/${month} 日報共 ${ogsmMonthReports.length} 筆`);

        // 🚀 若為主管身分，直接開啟並載入管轄團隊綜合指示點 (無須主管模式字樣)
        if (isCurrentUserManager()) {
          loadTeamMonthlyDots(year, month);
        }
      } else {
        console.warn("[OGSM] 讀取月日報異常 (可能後端 GAS 尚未部署新版):", data.msg);
      }
    } catch (err) {
      console.warn("[OGSM] 讀取月日報網路失敗，載入本機快取:", err);
      // 離線狀態下從離線暫存標註
      const offlineList = getOfflineOgsmDrafts();
      offlineList.forEach(item => {
        if (item.date && item.date.startsWith(`${year}-${month < 10 ? '0' : ''}${month}`)) {
          ogsmDatesWithReports.add(item.date);
        }
      });
      renderCalendar(year, month);
    }
  }

  // 🚀 主管專用：載入全團隊綜合月曆指示點
  async function loadTeamMonthlyDots(year, month) {
    try {
      const params = new URLSearchParams({
        action: "get_ogsm_team_monthly_dots",
        user_name: getSalesName(),
        year: year.toString(),
        month: month.toString(),
        is_test: isTestMode ? "1" : "0"
      });
      const res = await fetch(`${GAS_URL}?${params.toString()}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.status === "ok" && data.dots) {
        ogsmTeamDotsMap = data.dots;
        renderCalendar(year, month);
        console.log("[OGSM 主管模式] 團隊綜合圓點已更新:", ogsmTeamDotsMap);
      }
    } catch (e) {
      console.warn("[OGSM] 載入團隊綜合圓點失敗:", e);
    }
  }

  function refreshCurrentDayModal() {
    if (!currentViewingDate) return;
    renderDayReportList(currentViewingDate);
    // 圓點狀態即時刷新
    renderCalendar(ogsmCurrentYear, ogsmCurrentMonth);
  }

  // ====================================================
  // 日期點擊互動處理 (選項 B：月曆下方常駐案件清單連動)
  // ====================================================
  function handleDayClick(dateStr) {
    currentViewingDate = dateStr;

    // 高亮所選日期格子
    if (ogsmCalendarGrid) {
      ogsmCalendarGrid.querySelectorAll(".calendar-day").forEach(c => {
        if (c.dataset.date === dateStr) c.classList.add("selected");
        else c.classList.remove("selected");
      });
    }

    renderDayReportList(dateStr);
  }

  // 渲染當日日報卡片清單 (直接嵌入月曆下方，選項 B)
  function renderDayReportList(dateStr) {
    if (!ogsmDayReportList) return;
    currentViewingDate = dateStr;

    const onlineList = ogsmMonthReports.filter(r => r.date === dateStr);
    const offlineList = getOfflineOgsmDrafts().filter(r => r.date === dateStr);
    const syncingList = ogsmSyncingReports.filter(r => r.date === dateStr);
    const reports = [...syncingList, ...offlineList, ...onlineList];

    const isMgr = typeof isCurrentUserManager === "function" && isCurrentUserManager();

    if (ogsmDayViewTitle) {
      if (isMgr) {
        ogsmDayViewTitle.textContent = `📅 ${dateStr} 業務日報 (個人 ${reports.length} 筆)`;
      } else {
        ogsmDayViewTitle.textContent = `📅 ${dateStr} 業務日報 (${reports.length} 筆)`;
      }
    }

    // 若處於連線狀態且無同步中任務，嘗試將離線暫存補傳
    if (navigator.onLine && !isOgsmSyncing) {
      syncOfflineOgsmDrafts();
    }

    let html = "";
    if (!reports || reports.length === 0) {
      if (isMgr) {
        html = `<div class="ogsm-empty-tip" style="padding:10px 14px; background:#f8fafc; border:1px dashed #cbd5e1; border-radius:8px; color:#64748b; font-size:0.85rem; margin-bottom:8px;">主管個人本日尚無拜訪日報（全團隊拜訪行程與回填狀態請見下方即時總覽）</div>`;
      } else {
        html = `<div class="ogsm-empty-tip">本日尚無拜訪日報紀錄，可點擊上方「➕ 新增此日日報」</div>`;
      }
    } else {
      reports.forEach((item, idx) => {
        const isSyncing = !!item.is_syncing;
        const isOffline = !!item.offline_id && !isSyncing;

        let badgeHtml = "";
        if (isSyncing) {
          badgeHtml = '<span class="badge-syncing">⏳ 同步中</span>';
        } else if (isOffline) {
          badgeHtml = '<span class="badge-offline">⏳ 離線暫存</span>';
        }

        let actionsHtml = "";
        if (isSyncing) {
          actionsHtml = '<span style="font-size:0.78rem; color:#0284c7; font-weight:500;">⚡ 背景同步中...</span>';
        } else if (isOffline) {
          actionsHtml = `
            <button type="button" class="btn-resend-ogsm" data-offline-id="${escapeHtml(item.offline_id)}">⚡ 立即重傳</button>
            <button type="button" class="btn-del-ogsm" data-offline="1" data-offline-id="${escapeHtml(item.offline_id)}">
              <svg viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
              刪除
            </button>
          `;
        } else {
          actionsHtml = `
            <button type="button" class="btn-history-ogsm" data-idx="${idx}">📜 歷史紀錄</button>
            <button type="button" class="btn-crm-sync" data-idx="${idx}" title="轉入客戶關係表單 (CRM)">🔗 轉入 CRM</button>
            <button type="button" class="btn-edit-ogsm" data-idx="${idx}">✏️ 編輯</button>
            <button type="button" class="btn-del-ogsm" data-row="${item.row_index || ''}" data-offline="0">
              <svg viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
              刪除
            </button>
          `;
        }

        html += `
          <div class="ogsm-report-card" data-idx="${idx}" data-syncing="${isSyncing ? '1' : '0'}">
            <div class="ogsm-card-header">
              <span class="ogsm-card-client">${escapeHtml(item.client_name)}</span>
              <div>
                <span class="badge-client-type">${escapeHtml(item.client_type || '其它')}</span>
                ${badgeHtml}
              </div>
            </div>
            <div class="ogsm-card-section">
              <span class="ogsm-card-label">工作內容：</span>
              <span class="ogsm-card-text">${escapeHtml(item.content || '無')}</span>
            </div>
            <div class="ogsm-card-section">
              <span class="ogsm-card-label">實際行程：</span>
              <span class="ogsm-card-text">${escapeHtml(item.result || '無')}</span>
            </div>
            <div class="ogsm-card-footer">
              <span>更新：${escapeHtml(formatTwDateTime(item.updated_at || item.created_at))}</span>
              <div class="ogsm-card-actions">
                ${actionsHtml}
              </div>
            </div>
          </div>
        `;
      });
    }

    ogsmDayReportList.innerHTML = html;

    // 綁定卡片點擊進入編輯
    ogsmDayReportList.querySelectorAll(".ogsm-report-card").forEach(card => {
      card.addEventListener("click", () => {
        if (card.dataset.syncing === "1") {
          showToast("此日報正在背景同步中，請稍候...", "info");
          return;
        }
        const idx = parseInt(card.dataset.idx, 10);
        const item = reports[idx];
        if (item) {
          openOgsmEditModal(dateStr, item);
        }
      });
    });

    // 綁定轉入 CRM 按鈕
    ogsmDayReportList.querySelectorAll(".btn-crm-sync").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx, 10);
        const item = reports[idx];
        if (item) {
          openCrmSyncModal(item, dateStr);
        }
      });
    });

    // 綁定歷史紀錄檢視按鈕
    ogsmDayReportList.querySelectorAll(".btn-history-ogsm").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx, 10);
        const item = reports[idx];
        if (item) {
          showHistoryModal(item.client_name, item.history, dateStr);
        }
      });
    });

    // 綁定編輯按鈕
    ogsmDayReportList.querySelectorAll(".btn-edit-ogsm").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx, 10);
        const item = reports[idx];
        if (item) {
          openOgsmEditModal(dateStr, item);
        }
      });
    });

    // 綁定各卡片刪除按鈕
    ogsmDayReportList.querySelectorAll(".btn-del-ogsm").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const rIndex = btn.dataset.row;
        const isOff = btn.dataset.offline === "1";
        const offId = btn.dataset.offlineId;
        deleteOgsmReport(rIndex, isOff, offId, dateStr);
      });
    });

    // 綁定單筆立即重傳按鈕
    ogsmDayReportList.querySelectorAll(".btn-resend-ogsm").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const offId = btn.dataset.offlineId;
        await resendSingleOfflineOgsmDraft(offId, dateStr);
      });
    });

    // 🚀 主管模式：在個人日報下方追加載入全團隊當日動態總覽
    if (isCurrentUserManager()) {
      loadTeamDailyView(dateStr);
    }
  }

  if (btnAddDayReport) {
    btnAddDayReport.addEventListener("click", () => {
      openOgsmEditModal(currentViewingDate);
    });
  }

  // ====================================================
  // 🚀 模組一：主管團隊動態清單載入 (選項 B：團隊總覽儀表板)
  // ====================================================
  // ====================================================
  // 🚀 模組一：主管團隊動態清單載入 (記憶體快取 + 骨架屏 + SWR 秒開優化)
  // ====================================================
  const teamDailyCache = new Map();

  function prefetchTeamDaily(dateStr) {
    if (!isCurrentUserManager()) return;
    if (teamDailyCache.has(dateStr)) return;
    const params = new URLSearchParams({
      action: "get_ogsm_team_daily",
      user_name: getSalesName(),
      date: dateStr,
      is_test: isTestMode ? "1" : "0"
    });
    fetch(`${GAS_URL}?${params.toString()}`)
      .then(res => res.json())
      .then(data => {
        if (data && data.status === "ok") {
          teamDailyCache.set(dateStr, data);
        }
      })
      .catch(() => {});
  }

  function renderTeamDailyHtml(data) {
    if (!ogsmDayReportList) return;
    const oldWrap = ogsmDayReportList.querySelector(".team-overview-wrap");
    if (oldWrap) oldWrap.remove();
    const loadingElem = ogsmDayReportList.querySelector("#teamOverviewLoading");
    if (loadingElem) loadingElem.remove();

    if (!data || !Array.isArray(data.team_reports) || data.team_reports.length === 0) {
      ogsmDayReportList.insertAdjacentHTML("beforeend", `
        <div class="team-overview-wrap" style="margin-top:1.5rem; padding:14px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; text-align:center; color:#64748b; font-size:0.85rem;">
          👥 全團隊於此日尚無拜訪動態紀錄
        </div>
      `);
      return;
    }

    let teamHtml = `
      <div class="team-overview-wrap" style="margin-top:1.5rem; padding-top:1.25rem; border-top:2px dashed #cbd5e1;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
          <h4 style="margin:0; font-size:1.05rem; color:#1e40af; font-weight:700;">
            👥 全團隊今日拜訪動態總覽 (${data.team_reports.length} 位業務)
          </h4>
          <span style="font-size:0.75rem; color:#64748b;">主管專屬監看</span>
        </div>
    `;

    data.team_reports.forEach(teamUser => {
      const isExempt = !!teamUser.is_exempt;
      const userReports = teamUser.records || [];
      const allUserDone = userReports.every(r => (r.content && r.result));
      const statusBadge = allUserDone 
        ? '<span class="team-sales-status-badge completed">🔵 全程已完成</span>'
        : '<span class="team-sales-status-badge pending">🔴 待回填行程</span>';

      teamHtml += `
        <div class="team-sales-card">
          <div class="team-sales-header">
            <span class="team-sales-name">👤 ${escapeHtml(teamUser.sales_name)} ${isExempt ? '<span style="font-size:0.72rem; color:#64748b; font-weight:normal;">(主管/經銷豁免)</span>' : ''}</span>
            ${statusBadge}
          </div>
          <div style="display:flex; flex-direction:column; gap:8px;">
      `;

      userReports.forEach(r => {
        teamHtml += `
          <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:6px; padding:8px 10px; font-size:0.85rem;">
            <div style="display:flex; justify-content:space-between; font-weight:600; margin-bottom:4px;">
              <span style="color:#0f172a;">🏢 ${escapeHtml(r.client_name)}</span>
              <span style="font-size:0.75rem; background:#f1f5f9; padding:2px 6px; border-radius:4px;">${escapeHtml(r.client_type || '其它')}</span>
            </div>
            <div style="color:#334155; margin-bottom:2px;"><span style="color:#64748b;">計畫：</span>${escapeHtml(r.content || '無')}</div>
            <div style="color:#0f172a;"><span style="color:#64748b;">實際：</span>${escapeHtml(r.result || '待回填')}</div>
          </div>
        `;
      });

      teamHtml += `
          </div>
        </div>
      `;
    });

    teamHtml += `</div>`;
    ogsmDayReportList.insertAdjacentHTML("beforeend", teamHtml);
  }

  async function loadTeamDailyView(dateStr) {
    if (!ogsmDayReportList) return;

    // 1. 若記憶體快取已有此日期的團隊動態，【立即 0 毫秒極速渲染】，主管完全無需等待
    if (teamDailyCache.has(dateStr)) {
      renderTeamDailyHtml(teamDailyCache.get(dateStr));
    } else {
      // 2. 若快取尚未就緒，立即顯示美觀的骨架屏讀取指示器，消除畫面空白延遲感
      const oldLoading = ogsmDayReportList.querySelector("#teamOverviewLoading");
      if (oldLoading) oldLoading.remove();
      const oldWrap = ogsmDayReportList.querySelector(".team-overview-wrap");
      if (oldWrap) oldWrap.remove();

      ogsmDayReportList.insertAdjacentHTML("beforeend", `
        <div id="teamOverviewLoading" style="margin-top:1.5rem; padding:16px; background:#f8fafc; border:1px dashed #cbd5e1; border-radius:8px; text-align:center;">
          <div style="font-size:0.9rem; font-weight:600; color:#2563eb; display:flex; align-items:center; justify-content:center; gap:8px;">
            <span style="display:inline-block; font-size:1.1rem; animation:pulse 1.2s infinite;">⏳</span> 正在即時載入全團隊今日拜訪動態...
          </div>
          <div style="font-size:0.75rem; color:#94a3b8; margin-top:4px;">主管專屬監看資料彙整中</div>
        </div>
      `);
    }

    // 3. 背景非同步向 GAS 取得最新數據並更新快取 (SWR 機制)
    try {
      const params = new URLSearchParams({
        action: "get_ogsm_team_daily",
        user_name: getSalesName(),
        date: dateStr,
        is_test: isTestMode ? "1" : "0"
      });
      const res = await fetch(`${GAS_URL}?${params.toString()}`);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();

      if (data && data.status === "ok") {
        teamDailyCache.set(dateStr, data);
        // 若主管目前視窗仍停留在該日期，自動刷新最新內容
        if (currentViewingDate === dateStr) {
          renderTeamDailyHtml(data);
        }
      } else {
        const loadingElem = ogsmDayReportList.querySelector("#teamOverviewLoading");
        if (loadingElem) {
          loadingElem.innerHTML = `
            <div style="font-size:0.85rem; color:#dc2626; padding:10px; background:#fef2f2; border:1px solid #fecaca; border-radius:6px; text-align:center;">
              ⚠️ 團隊動態讀取提示：${escapeHtml(data && data.msg ? data.msg : '伺服器未回傳有效資料，請確認後端已重新發布新版本')}
            </div>
          `;
        }
      }
    } catch (e) {
      console.warn("[OGSM] 載入團隊總覽失敗:", e);
      const loading = ogsmDayReportList.querySelector("#teamOverviewLoading");
      if (loading) {
        loading.innerHTML = `
          <div style="font-size:0.85rem; color:#dc2626; padding:10px; background:#fef2f2; border:1px solid #fecaca; border-radius:6px; text-align:center;">
            ⚠️ 連線伺服器逾時或失敗，請稍候重試或檢查網路連線
          </div>
        `;
      }
    }
  }

  // ====================================================
  // 🚀 模組二：同步至客戶關係表單 (CRM) 互動處理
  // ====================================================
  function openCrmSyncModal(item, visitDate) {
    activeSyncOgsmItem = item;
    if (crmModalSubTitle) {
      crmModalSubTitle.textContent = `正在同步：${visitDate} ${item.client_name || ''}`;
    }
    if (crmInputUserName) crmInputUserName.value = getSalesName();
    if (crmInputVisitDate) crmInputVisitDate.value = visitDate;
    if (crmInputClientName) crmInputClientName.value = item.client_name || "";
    if (crmInputPurpose) crmInputPurpose.value = item.content || "";
    if (crmInputStatusDesc) crmInputStatusDesc.value = item.result || "";
    if (crmInputCompChannel) crmInputCompChannel.value = "";
    if (crmSelectClientNature) populateClientNatureOptions(crmSelectClientNature, "A 級（持續大手）");
    if (crmSelectLostRetrieved) crmSelectLostRetrieved.value = "";
    if (crmInputActionPlan) crmInputActionPlan.value = "";
    
    // 初始化客戶所屬下拉選單 (預設為自己，但可切換真正歸屬人)
    if (crmSelectClientOwner) {
      crmSelectClientOwner.innerHTML = ALL_SALES_MEMBERS.map(m => {
        const selected = (m === getSalesName() || getSalesName().includes(m)) ? "selected" : "";
        return `<option value="${m}" ${selected}>${m}</option>`;
      }).join("");
    }

    if (ogsmCrmModal) ogsmCrmModal.classList.remove("hidden");
  }

  if (btnCloseCrmModal) {
    btnCloseCrmModal.addEventListener("click", () => {
      if (ogsmCrmModal) ogsmCrmModal.classList.add("hidden");
    });
  }

  if (btnCancelCrmModal) {
    btnCancelCrmModal.addEventListener("click", () => {
      if (ogsmCrmModal) ogsmCrmModal.classList.add("hidden");
    });
  }

  if (btnSubmitCrmModal) {
    btnSubmitCrmModal.addEventListener("click", async () => {
      const userName = crmInputUserName?.value || getSalesName();
      const visitDate = crmInputVisitDate?.value || "";
      const clientName = crmInputClientName?.value || "";
      const clientOwner = crmSelectClientOwner?.value || userName;
      const purpose = crmInputPurpose?.value || "";
      const statusDesc = crmInputStatusDesc?.value || "";
      const industry = crmSelectIndustry?.value || "";
      const channel = crmSelectChannel?.value || "";
      const compChannel = crmInputCompChannel?.value?.trim() || "";
      const clientNature = crmSelectClientNature?.value || "";
      const isLostRetrieved = crmSelectLostRetrieved?.value || "";
      const actionPlan = crmInputActionPlan?.value?.trim() || "";
      const expectedMonth = crmSelectExpectedMonth?.value || "";
      const amount = crmInputAmount?.value || "0";
      const brand = crmSelectBrand?.value || "";
      const dependencies = crmInputDependencies?.value || "";

      // 取得勾選之推廣產品
      const selectedProducts = [];
      document.querySelectorAll("#crmPromotedProductsWrap input[name='crmProduct']:checked").forEach(cb => {
        selectedProducts.push(cb.value);
      });
      const promotedProducts = selectedProducts.join("、");

      if (!clientName) {
        alert("請確認客戶名稱");
        return;
      }

      btnSubmitCrmModal.disabled = true;
      btnSubmitCrmModal.textContent = "⚡ 正在同步至 CRM 試算表...";

      try {
        const params = new URLSearchParams({
          action: "sync_ogsm_to_crm",
          user_name: userName,
          visit_date: visitDate,
          client_name: clientName,
          client_owner: clientOwner,
          purpose_or_project: purpose,
          status_description: statusDesc,
          promoted_products: promotedProducts,
          expected_month: expectedMonth,
          estimated_amount: amount,
          dependencies: dependencies,
          competing_brand: brand,
          industry: industry,
          channel: channel,
          comp_channel: compChannel,
          client_nature: clientNature,
          is_lost_retrieved: isLostRetrieved,
          action_plan: actionPlan
        });

        const res = await fetch(`${GAS_URL}?${params.toString()}`);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();

        if (data.status === "ok") {
          showToast(data.msg || "✅ 已成功同步至客戶關係表單 (CRM)", "success");
          if (ogsmCrmModal) ogsmCrmModal.classList.add("hidden");
          // 標記當前卡片為已同步
          if (activeSyncOgsmItem) {
            activeSyncOgsmItem.crm_synced = true;
          }
          invalidateMonthlyReportCaches();
          refreshCurrentDayModal();
        } else {
          alert("同步 CRM 失敗：" + (data.msg || "未知錯誤"));
        }
      } catch (err) {
        console.error("同步 CRM 網路異常:", err);
        alert("同步 CRM 失敗，請檢查網路連線或稍後再試。");
      } finally {
        btnSubmitCrmModal.disabled = false;
        btnSubmitCrmModal.textContent = "⚡ 確認上傳 CRM";
      }
    });
  }

  // ====================================================
  // 🚀 模組四：報價單多選關聯 CRM 案件處理
  // ====================================================
  function renderCrmLinkedBadges() {
    if (!crmLinkedCasesWrap || !crmLinkedCasesList) return;
    if (!selectedCrmCases || selectedCrmCases.length === 0) {
      crmLinkedCasesWrap.classList.add("hidden");
      crmLinkedCasesList.innerHTML = "";
      return;
    }

    crmLinkedCasesWrap.classList.remove("hidden");
    crmLinkedCasesList.innerHTML = selectedCrmCases.map(c => `
      <div class="crm-case-tag">
        <span class="crm-case-tag-name">🏢 ${escapeHtml(c.client_name)} - ${escapeHtml(c.case_name)}</span>
        <span class="crm-case-tag-amount">預估 ${c.estimated_amount || 0} 萬</span>
      </div>
    `).join("");
  }

  if (btnClearCrmLinks) {
    btnClearCrmLinks.addEventListener("click", () => {
      selectedCrmCases = [];
      renderCrmLinkedBadges();
      showToast("已清除 CRM 關聯綁定", "info");
    });
  }

  if (btnLinkCrmCase) {
    btnLinkCrmCase.addEventListener("click", () => {
      const currentClient = (customerNameInput?.value || "").trim();
      const cleanClient = currentClient.includes(" - ") ? currentClient.split(" - ")[0].trim() : currentClient;
      if (!cleanClient) {
        showToast("⚠️ 請先在上方輸入或選擇客戶名稱，系統將依客戶精準連結專屬 CRM 商機", "warning");
        if (customerNameInput) customerNameInput.focus();
        return;
      }
      openCrmCaseSelector(cleanClient);
    });
  }

  async function openCrmCaseSelector(targetClientName = "", searchKw = "") {
    if (!crmCaseSelectorModal) return;
    const currentClient = targetClientName || customerNameInput?.value || "";
    const cleanClient = currentClient.includes(" - ") ? currentClient.split(" - ")[0].trim() : currentClient.trim();

    if (!cleanClient) {
      showToast("⚠️ 請先在上方輸入或選擇客戶名稱，方可檢索專屬 CRM 案件", "warning");
      return;
    }

    if (crmCaseTierHint) {
      crmCaseTierHint.textContent = `💡 正在檢索客戶「${cleanClient}」專屬 CRM 商機案件，可勾選 1 至多筆合併報價：`;
    }

    if (crmCaseSelectorList) {
      crmCaseSelectorList.innerHTML = '<div style="text-align:center; padding:20px; color:#64748b;">⏳ 正在自雲端讀取 CRM 案件...</div>';
    }

    crmCaseSelectorModal.classList.remove("hidden");

    try {
      const params = new URLSearchParams({
        action: "get_crm_open_cases",
        sales_name: getSalesName(),
        client_name: cleanClient,
        keyword: searchKw
      });

      const res = await fetch(`${GAS_URL}?${params.toString()}`);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();

      if (data.status === "ok" && Array.isArray(data.cases) && data.cases.length > 0) {
        // 嚴格依客戶名稱進行客戶隔離比對，徹底排除其他非關聯客戶案件
        const clientCases = data.cases.filter(c => {
          const cName = (c.client_name || "").trim().toLowerCase();
          const target = cleanClient.toLowerCase();
          return cName.includes(target) || target.includes(cName);
        });

        if (clientCases.length > 0) {
          renderCrmCaseList(clientCases, cleanClient);
        } else {
          if (crmCaseSelectorList) crmCaseSelectorList.innerHTML = `<div style="text-align:center; padding:15px; color:#64748b;">查無客戶「${escapeHtml(cleanClient)}」相符的進行中 CRM 商機案件</div>`;
        }
      } else {
        if (crmCaseSelectorList) crmCaseSelectorList.innerHTML = `<div style="text-align:center; padding:15px; color:#64748b;">查無客戶「${escapeHtml(cleanClient)}」相符的進行中 CRM 商機案件</div>`;
      }
    } catch (e) {
      console.warn("載入 CRM 案件失敗:", e);
      if (crmCaseSelectorList) crmCaseSelectorList.innerHTML = '<div style="text-align:center; padding:15px; color:#ef4444;">連線失敗，無法取得 CRM 案件</div>';
    }
  }

  function renderCrmCaseList(cases, targetClient) {
    if (!crmCaseSelectorList) return;
    if (!cases || cases.length === 0) {
      crmCaseSelectorList.innerHTML = `<div style="text-align:center; padding:15px; color:#64748b;">查無客戶「${escapeHtml(targetClient)}」相符之 CRM 案件</div>`;
      return;
    }

    const selectedKeys = new Set(selectedCrmCases.map(c => `${c.client_name}_${c.case_name}`));

    let html = "";
    cases.forEach((c, idx) => {
      const key = `${c.client_name}_${c.case_name}`;
      const isChecked = selectedKeys.has(key);

      html += `
        <label class="crm-selector-item" style="display:flex; align-items:flex-start; gap:10px; background:#f0f9ff; border:1px solid #7dd3fc; border-radius:8px; padding:10px; cursor:pointer;">
          <input type="checkbox" name="crmCaseItem" value="${idx}" ${isChecked ? 'checked' : ''} style="margin-top:3px; transform:scale(1.15);">
          <div style="flex:1;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3px;">
              <span style="font-weight:700; color:#0f172a; font-size:0.9rem;">🏢 ${escapeHtml(c.client_name)}</span>
              <span style="font-size:0.75rem; color:#059669; font-weight:700; background:#ecfdf5; padding:2px 6px; border-radius:4px;">
                預估 ${c.estimated_amount || 0} 萬
              </span>
            </div>
            <div style="font-size:0.85rem; color:#1e3a8a; font-weight:600; margin-bottom:2px;">
              ${escapeHtml(c.case_name || '無案件名稱')}
            </div>
            <div style="font-size:0.78rem; color:#64748b; line-height:1.3;">
              產品：${escapeHtml(c.promoted_products || '未註明')} | 業務：${escapeHtml(c.client_owner || c.sales_name)} | ${escapeHtml(c.created_at || '')}
            </div>
          </div>
        </label>
      `;
    });

    crmCaseSelectorList.innerHTML = html;
    crmCaseSelectorList._loadedCases = cases;
  }

  if (btnCloseCrmCaseSelector) {
    btnCloseCrmCaseSelector.addEventListener("click", () => {
      if (crmCaseSelectorModal) crmCaseSelectorModal.classList.add("hidden");
    });
  }

  if (btnCancelCrmCaseSelector) {
    btnCancelCrmCaseSelector.addEventListener("click", () => {
      if (crmCaseSelectorModal) crmCaseSelectorModal.classList.add("hidden");
    });
  }

  if (crmCaseSearchInput) {
    let searchDebounce = null;
    crmCaseSearchInput.addEventListener("input", () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        openCrmCaseSelector("", crmCaseSearchInput.value.trim());
      }, 300);
    });
  }

  if (btnConfirmCrmCaseSelector) {
    btnConfirmCrmCaseSelector.addEventListener("click", () => {
      const cases = crmCaseSelectorList?._loadedCases || [];
      const newSelected = [];
      document.querySelectorAll("#crmCaseSelectorList input[name='crmCaseItem']:checked").forEach(cb => {
        const idx = parseInt(cb.value, 10);
        if (cases[idx]) newSelected.push(cases[idx]);
      });

      selectedCrmCases = newSelected;
      renderCrmLinkedBadges();

      if (crmCaseSelectorModal) crmCaseSelectorModal.classList.add("hidden");
      showToast(`已成功關聯 ${selectedCrmCases.length} 筆 CRM 案件`, "success");
    });
  }

  // ====================================================
  // ====================================================
  // 🚀 模組五：商機導向精簡月報匯出 (CRM 商機月報 + OGSM 商機月報)
  // ====================================================
  let currentMonthlyReportRecords = [];
  let currentOgsmReportRecords = [];

  // 工具函式：格式化日期為 YYYY-MM-DD
  function formatDateToYMD(d) {
    const y = d.getFullYear();
    const m = ("0" + (d.getMonth() + 1)).slice(-2);
    const day = ("0" + d.getDate()).slice(-2);
    return `${y}-${m}-${day}`;
  }

  // ====================================================
  // 🚀 桌機版風格日期範圍選取器控制器 (WebDateRangePicker)
  // 對齊桌機版 RangeCalendarPopup：導航切換、紅字週末、深藍起訖圓形、淡藍連續區間、清除與確定
  // ====================================================
  let currentDrpContext = null;
  let drpViewYear = new Date().getFullYear();
  let drpViewMonth = new Date().getMonth() + 1; // 1-12
  let drpStartDate = null; // YYYY-MM-DD
  let drpEndDate = null;   // YYYY-MM-DD
  let drpPhase = 0;        // 0: 未選, 1: 選了開始, 2: 選了結束

  const DRP_MONTHS_ZH = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];

  function openDateRangePicker(context) {
    currentDrpContext = context;
    const startVal = context.startInput?.value || "";
    const endVal = context.endInput?.value || "";

    drpStartDate = startVal || null;
    drpEndDate = endVal || null;
    drpPhase = (drpStartDate && drpEndDate) ? 2 : (drpStartDate ? 1 : 0);

    if (drpEndDate) {
      const parts = drpEndDate.split("-");
      drpViewYear = parseInt(parts[0], 10);
      drpViewMonth = parseInt(parts[1], 10);
    } else if (drpStartDate) {
      const parts = drpStartDate.split("-");
      drpViewYear = parseInt(parts[0], 10);
      drpViewMonth = parseInt(parts[1], 10);
    } else {
      const now = new Date();
      drpViewYear = now.getFullYear();
      drpViewMonth = now.getMonth() + 1;
    }

    renderDrpCalendar();

    if (drpPopup && context.triggerBtn) {
      drpPopup.classList.remove("hidden");
      const rect = context.triggerBtn.getBoundingClientRect();
      const popupWidth = 310;
      let left = rect.left;
      if (left + popupWidth > window.innerWidth - 10) {
        left = window.innerWidth - popupWidth - 10;
      }
      if (left < 10) left = 10;

      let top = rect.bottom + 6;
      if (top + 360 > window.innerHeight && rect.top > 370) {
        top = rect.top - 360;
      }
      drpPopup.style.left = `${left}px`;
      drpPopup.style.top = `${top}px`;
    }
  }

  function closeDateRangePicker() {
    if (drpPopup) drpPopup.classList.add("hidden");
    currentDrpContext = null;
  }

  function renderDrpCalendar() {
    if (!drpTitle || !drpGrid || !drpStatus) return;
    drpTitle.textContent = `${drpViewYear} 年  ${DRP_MONTHS_ZH[drpViewMonth - 1]}`;

    if (drpPhase === 0 || !drpStartDate) {
      drpStatus.textContent = "請選擇開始日期";
    } else if (drpPhase === 1 || !drpEndDate) {
      drpStatus.textContent = `開始：${drpStartDate.replace(/-/g, "/")}　請選擇結束日期`;
    } else {
      drpStatus.textContent = `${drpStartDate.replace(/-/g, "/")} ～ ${drpEndDate.replace(/-/g, "/")}`;
    }

    const firstDay = new Date(drpViewYear, drpViewMonth - 1, 1);
    const dayOfWeek = firstDay.getDay();
    const startCalDate = new Date(drpViewYear, drpViewMonth - 1, 1 - dayOfWeek);

    const todayStr = formatDateToYMD(new Date());
    let html = "";

    for (let i = 0; i < 42; i++) {
      const d = new Date(startCalDate.getFullYear(), startCalDate.getMonth(), startCalDate.getDate() + i);
      const dStr = formatDateToYMD(d);
      const isCurrentMonth = (d.getMonth() === drpViewMonth - 1);
      const isWeekend = (d.getDay() === 0 || d.getDay() === 6);
      const isToday = (dStr === todayStr);

      const isStart = (drpStartDate && dStr === drpStartDate);
      const isEnd = (drpEndDate && dStr === drpEndDate);
      const inRange = (drpStartDate && drpEndDate && dStr > drpStartDate && dStr < drpEndDate);

      let classes = ["drp-day-btn"];
      if (!isCurrentMonth) classes.push("drp-out");
      if (isWeekend) classes.push("drp-we");
      if (isToday) classes.push("drp-today");
      if (isStart) classes.push("drp-sel-start");
      if (isEnd) classes.push("drp-sel-end");
      if (inRange) classes.push("drp-in-range");

      html += `<button type="button" class="${classes.join(' ')}" data-date="${dStr}">${d.getDate()}</button>`;
    }

    drpGrid.innerHTML = html;

    drpGrid.querySelectorAll(".drp-day-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const dateClicked = btn.dataset.date;
        handleDrpDateClick(dateClicked);
      });
    });
  }

  function handleDrpDateClick(dateClicked) {
    if (drpPhase === 0 || drpPhase === 2 || !drpStartDate) {
      drpStartDate = dateClicked;
      drpEndDate = null;
      drpPhase = 1;
    } else {
      if (dateClicked < drpStartDate) {
        drpEndDate = drpStartDate;
        drpStartDate = dateClicked;
      } else {
        drpEndDate = dateClicked;
      }
      drpPhase = 2;
    }
    renderDrpCalendar();
  }

  if (drpPrevBtn) {
    drpPrevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      drpViewMonth--;
      if (drpViewMonth < 1) {
        drpViewMonth = 12;
        drpViewYear--;
      }
      renderDrpCalendar();
    });
  }
  if (drpNextBtn) {
    drpNextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      drpViewMonth++;
      if (drpViewMonth > 12) {
        drpViewMonth = 1;
        drpViewYear++;
      }
      renderDrpCalendar();
    });
  }

  if (drpBtnClear) {
    drpBtnClear.addEventListener("click", (e) => {
      e.stopPropagation();
      drpStartDate = null;
      drpEndDate = null;
      drpPhase = 0;
      renderDrpCalendar();
    });
  }

  if (drpBtnOk) {
    drpBtnOk.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!currentDrpContext) {
        closeDateRangePicker();
        return;
      }

      if (drpStartDate && !drpEndDate) {
        drpEndDate = drpStartDate;
      }

      const s = drpStartDate || "";
      const en = drpEndDate || "";

      if (currentDrpContext.startInput) currentDrpContext.startInput.value = s;
      if (currentDrpContext.endInput) currentDrpContext.endInput.value = en;

      if (currentDrpContext.displaySpan) {
        if (s && en) {
          currentDrpContext.displaySpan.textContent = `${s.replace(/-/g, "/")} ~ ${en.replace(/-/g, "/")}`;
        } else if (s) {
          currentDrpContext.displaySpan.textContent = s.replace(/-/g, "/");
        } else {
          currentDrpContext.displaySpan.textContent = "請選擇日期範圍";
        }
      }

      const onConfirm = currentDrpContext.onConfirm;
      closeDateRangePicker();

      if (typeof onConfirm === "function") {
        onConfirm();
      }
    });
  }

  document.addEventListener("pointerdown", (e) => {
    if (!drpPopup || drpPopup.classList.contains("hidden")) return;
    if (drpPopup.contains(e.target)) return;
    if (currentDrpContext && currentDrpContext.triggerBtn && currentDrpContext.triggerBtn.contains(e.target)) return;
    closeDateRangePicker();
  });

  // ----------------------------------------------------
  // 1. CRM 商機月報
  // ----------------------------------------------------
  if (btnOpenMonthlyReportModal) {
    btnOpenMonthlyReportModal.addEventListener("click", () => {
      openMonthlyReportModal();
    });
  }

  if (btnCloseMonthlyReportModal) {
    btnCloseMonthlyReportModal.addEventListener("click", () => {
      if (monthlyReportModal) monthlyReportModal.classList.add("hidden");
    });
  }

  // 🚀 綁定 CRM 月報日期按鈕
  if (monthlyReportDateRangeBtn) {
    monthlyReportDateRangeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openDateRangePicker({
        triggerBtn: monthlyReportDateRangeBtn,
        startInput: monthlyReportStartDate,
        endInput: monthlyReportEndDate,
        displaySpan: monthlyReportDateDisplay,
        onConfirm: () => loadMonthlyReportData()
      });
    });
  }

  function openMonthlyReportModal() {
    if (!monthlyReportModal) return;
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // 預設日期區間：近 30 天至今日 (可自由自選起訖)
    if (monthlyReportStartDate && !monthlyReportStartDate.value) {
      monthlyReportStartDate.value = formatDateToYMD(thirtyDaysAgo);
    }
    if (monthlyReportEndDate && !monthlyReportEndDate.value) {
      monthlyReportEndDate.value = formatDateToYMD(now);
    }

    if (monthlyReportDateDisplay && monthlyReportStartDate && monthlyReportEndDate) {
      monthlyReportDateDisplay.textContent = `${monthlyReportStartDate.value.replace(/-/g, "/")} ~ ${monthlyReportEndDate.value.replace(/-/g, "/")}`;
    }

    // 初始化業務人員清單 (主管可選全部/個別，一般業務嚴格鎖定自己)
    if (monthlyReportSalesSelect) {
      if (isCurrentUserManager()) {
        const cur = monthlyReportSalesSelect.value || "";
        monthlyReportSalesSelect.disabled = false;
        monthlyReportSalesSelect.innerHTML = `
          <option value="">-- 全體業務 (主管總覽) --</option>
          ${ALL_SALES_MEMBERS.map(m => `<option value="${m}" ${m === cur ? "selected" : ""}>${m}</option>`).join("")}
        `;
      } else {
        const myName = getSalesName();
        monthlyReportSalesSelect.innerHTML = `<option value="${myName}">${myName}</option>`;
        monthlyReportSalesSelect.disabled = true; // 權限隔離：一般業務鎖死
      }
    }

    monthlyReportModal.classList.remove("hidden");
    loadMonthlyReportData();
  }

  async function loadMonthlyReportData(forceRefresh = false) {
    if (!monthlyReportTableBody) return;

    const startDate = monthlyReportStartDate?.value || "";
    const endDate = monthlyReportEndDate?.value || "";
    const salesName = monthlyReportSalesSelect?.value || "";
    const cacheKey = `${startDate}_${endDate}_${salesName}`;

    // 1. SWR 秒開：若有快取且非強制刷新，0 秒直接渲染！
    const cached = crmReportCacheMap.get(cacheKey);
    let hasRenderedCache = false;
    if (cached && !forceRefresh && Array.isArray(cached.records)) {
      currentMonthlyReportRecords = cached.records;
      renderMonthlyReportTable(currentMonthlyReportRecords);
      hasRenderedCache = true;
      if (crmReportStatusHint) {
        crmReportStatusHint.innerHTML = '<span style="color:#2563eb; font-weight:600;">⚡ 0秒快取 (同步中...)</span>';
      }
    } else {
      monthlyReportTableBody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:20px; color:#64748b;">⏳ 正在自雲端整合 CRM 商機案件月報...</td></tr>';
      if (crmReportStatusHint) crmReportStatusHint.textContent = "";
    }

    try {
      const params = new URLSearchParams({
        action: "export_monthly_report",
        start_date: startDate,
        end_date: endDate,
        sales_name: salesName,
        viewer: getSalesName()
      });

      const res = await fetch(`${GAS_URL}?${params.toString()}`);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();

      if (data.status === "ok" && Array.isArray(data.records)) {
        let recs = data.records;
        if (salesName) {
          recs = recs.filter(r => (r.client_owner === salesName || r.user_name === salesName || r.sales_name === salesName));
        }
        currentMonthlyReportRecords = recs;

        // 寫入 SWR 快取
        crmReportCacheMap.set(cacheKey, { records: currentMonthlyReportRecords, all_sales: data.all_sales, timestamp: Date.now() });

        // 主管模式下動態補完真實業務名單
        if (Array.isArray(data.all_sales) && data.all_sales.length > 0 && isCurrentUserManager()) {
          const currentSelected = monthlyReportSalesSelect ? monthlyReportSalesSelect.value : "";
          ALL_SALES_MEMBERS = data.all_sales.filter(Boolean).sort();
          if (monthlyReportSalesSelect) {
            monthlyReportSalesSelect.innerHTML = `
              <option value="">-- 全體業務 (主管總覽) --</option>
              ${ALL_SALES_MEMBERS.map(m => `<option value="${m}" ${m === currentSelected ? "selected" : ""}>${m}</option>`).join("")}
            `;
          }
        }

        renderMonthlyReportTable(currentMonthlyReportRecords);
        if (crmReportStatusHint) {
          crmReportStatusHint.innerHTML = '<span style="color:#10b981; font-weight:600;">✅ 已是最新</span>';
          setTimeout(() => { if (crmReportStatusHint) crmReportStatusHint.textContent = ""; }, 3000);
        }
      } else {
        if (!hasRenderedCache) {
          monthlyReportTableBody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:15px; color:#64748b;">該區間尚無商機案件紀錄</td></tr>';
        }
      }
    } catch (e) {
      console.warn("載入月報失敗:", e);
      if (!hasRenderedCache) {
        monthlyReportTableBody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:15px; color:#ef4444;">連線失敗，無法取得月報數據</td></tr>';
      }
      if (crmReportStatusHint) {
        crmReportStatusHint.innerHTML = '<span style="color:#ef4444;">⚠️ 離線快取</span>';
      }
    }
  }

  function renderMonthlyReportTable(records) {
    if (!monthlyReportTableBody) return;
    if (!records || records.length === 0) {
      monthlyReportTableBody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:15px; color:#64748b;">該區間尚無商機案件紀錄</td></tr>';
      return;
    }

    let html = "";
    const sortedRecords = [...records].sort((a, b) => {
      const ta = new Date(a.latest_update || 0).getTime() || 0;
      const tb = new Date(b.latest_update || 0).getTime() || 0;
      return tb - ta;
    });

    const seenQuoteIds = new Set();
    sortedRecords.forEach((r, rIdx) => {
      let qId = (r.quotation_id && r.quotation_id !== '-') ? r.quotation_id : '';
      if (!qId && r.dependencies) {
        const m = r.dependencies.match(/【已開立報價單：([^，】]+)/);
        if (m) qId = m[1].trim();
      }

      if (qId) {
        if (seenQuoteIds.has(qId)) {
          qId = '';
        } else {
          seenQuoteIds.add(qId);
        }
      }

      const visitDateStr = formatDisplayDate(r.visit_date || (r.latest_update ? r.latest_update.split(' ')[0] : ''));

      html += `
        <tr class="clickable-row" data-crm-row-idx="${rIdx}" title="點選直接修改此商機">
          <td class="sticky-col-client" title="${escapeHtml(r.client_name || '-')}">${escapeHtml(r.client_name || '-')}</td>
          <td style="white-space:nowrap; font-weight:600; color:#1e40af;">${escapeHtml(visitDateStr)}</td>
          <td class="col-sales">${escapeHtml(r.sales_name || '-')}</td>
          <td class="col-case">${escapeHtml(r.case_name || '-')}</td>
          <td class="col-month" style="text-align:center;">${escapeHtml(r.target_month || '-')}</td>
          <td class="col-amount" style="text-align:right;">${r.estimated_amount ? r.estimated_amount + ' 萬' : '-'}</td>
          <td class="col-quote">${qId ? `<span style="font-weight:bold; color:#1d4ed8;">${escapeHtml(qId)}</span>` : '<span style="color:#94a3b8;">-</span>'}</td>
          <td class="col-desc">${escapeHtml(r.status_desc || '-')}</td>
        </tr>
      `;
    });

    monthlyReportTableBody.innerHTML = html;

    // 🚀 綁定點選列事件 → 於月報上方直接覆蓋彈出 CRM 編輯視窗
    monthlyReportTableBody.querySelectorAll("tr[data-crm-row-idx]").forEach(tr => {
      tr.addEventListener("click", () => {
        const idx = parseInt(tr.dataset.crmRowIdx, 10);
        const record = sortedRecords[idx];
        if (record) {
          openCrmEditModal(record, "monthly_report");
        }
      });
    });
  }

  if (monthlyReportStartDate) monthlyReportStartDate.addEventListener("change", () => loadMonthlyReportData(false));
  if (monthlyReportEndDate) monthlyReportEndDate.addEventListener("change", () => loadMonthlyReportData(false));
  if (monthlyReportSalesSelect) monthlyReportSalesSelect.addEventListener("change", () => loadMonthlyReportData(false));
  if (btnRefreshMonthlyReport) btnRefreshMonthlyReport.addEventListener("click", () => loadMonthlyReportData(true));

  // ----------------------------------------------------
  // 2. OGSM 團隊商機月報
  // ----------------------------------------------------
  if (btnOpenOgsmMonthlyReportModal) {
    btnOpenOgsmMonthlyReportModal.addEventListener("click", () => {
      openOgsmMonthlyReportModal();
    });
  }

  if (btnCloseOgsmMonthlyReportModal) {
    btnCloseOgsmMonthlyReportModal.addEventListener("click", () => {
      if (ogsmMonthlyReportModal) ogsmMonthlyReportModal.classList.add("hidden");
    });
  }

  // 🚀 綁定 OGSM 月報日期按鈕
  if (ogsmReportDateRangeBtn) {
    ogsmReportDateRangeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openDateRangePicker({
        triggerBtn: ogsmReportDateRangeBtn,
        startInput: ogsmReportStartDate,
        endInput: ogsmReportEndDate,
        displaySpan: ogsmReportDateDisplay,
        onConfirm: () => loadOgsmMonthlyReportData(false)
      });
    });
  }

  function openOgsmMonthlyReportModal() {
    if (!ogsmMonthlyReportModal) return;
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    if (ogsmReportStartDate && !ogsmReportStartDate.value) {
      ogsmReportStartDate.value = formatDateToYMD(thirtyDaysAgo);
    }
    if (ogsmReportEndDate && !ogsmReportEndDate.value) {
      ogsmReportEndDate.value = formatDateToYMD(now);
    }

    if (ogsmReportDateDisplay && ogsmReportStartDate && ogsmReportEndDate) {
      ogsmReportDateDisplay.textContent = `${ogsmReportStartDate.value.replace(/-/g, "/")} ~ ${ogsmReportEndDate.value.replace(/-/g, "/")}`;
    }

    if (ogsmReportSalesSelect) {
      if (isCurrentUserManager()) {
        const cur = ogsmReportSalesSelect.value || "";
        ogsmReportSalesSelect.disabled = false;
        ogsmReportSalesSelect.innerHTML = `
          <option value="">-- 全體業務 (主管總覽) --</option>
          ${ALL_SALES_MEMBERS.map(m => `<option value="${m}" ${m === cur ? "selected" : ""}>${m}</option>`).join("")}
        `;
      } else {
        const myName = getSalesName();
        ogsmReportSalesSelect.innerHTML = `<option value="${myName}">${myName}</option>`;
        ogsmReportSalesSelect.disabled = true; // 權限隔離：一般業務鎖死
      }
    }

    ogsmMonthlyReportModal.classList.remove("hidden");
    loadOgsmMonthlyReportData();
  }

  async function loadOgsmMonthlyReportData(forceRefresh = false) {
    if (!ogsmReportTableBody) return;

    const startDate = ogsmReportStartDate?.value || "";
    const endDate = ogsmReportEndDate?.value || "";
    const salesName = ogsmReportSalesSelect?.value || "";
    const cacheKey = `${startDate}_${endDate}_${salesName}`;

    // 1. SWR 秒開檢查
    const cached = ogsmReportCacheMap.get(cacheKey);
    let hasRenderedCache = false;
    if (cached && !forceRefresh && Array.isArray(cached.records)) {
      currentOgsmReportRecords = cached.records;
      renderOgsmReportTable(currentOgsmReportRecords);
      hasRenderedCache = true;
      if (ogsmReportStatusHint) {
        ogsmReportStatusHint.innerHTML = '<span style="color:#2563eb; font-weight:600;">⚡ 0秒快取 (同步中...)</span>';
      }
    } else {
      ogsmReportTableBody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:20px; color:#64748b;">⏳ 正在自雲端整合 OGSM 團隊商機月報...</td></tr>';
      if (ogsmReportStatusHint) ogsmReportStatusHint.textContent = "";
    }

    try {
      const params = new URLSearchParams({
        action: "export_ogsm_report",
        start_date: startDate,
        end_date: endDate,
        sales_name: salesName,
        viewer: getSalesName()
      });

      const res = await fetch(`${GAS_URL}?${params.toString()}`);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();

      if (data.status === "ok" && Array.isArray(data.records)) {
        currentOgsmReportRecords = data.records;
        ogsmReportCacheMap.set(cacheKey, { records: currentOgsmReportRecords, all_sales: data.all_sales, timestamp: Date.now() });

        // 主管模式下動態補完真實業務名單
        if (Array.isArray(data.all_sales) && data.all_sales.length > 0 && isCurrentUserManager()) {
          const currentSelected = ogsmReportSalesSelect ? ogsmReportSalesSelect.value : "";
          ALL_SALES_MEMBERS = data.all_sales.filter(Boolean).sort();
          if (ogsmReportSalesSelect) {
            ogsmReportSalesSelect.innerHTML = `
              <option value="">-- 全體業務 (主管總覽) --</option>
              ${ALL_SALES_MEMBERS.map(m => `<option value="${m}" ${m === currentSelected ? "selected" : ""}>${m}</option>`).join("")}
            `;
          }
        }

        renderOgsmReportTable(currentOgsmReportRecords);
        if (ogsmReportStatusHint) {
          ogsmReportStatusHint.innerHTML = '<span style="color:#10b981; font-weight:600;">✅ 已是最新</span>';
          setTimeout(() => { if (ogsmReportStatusHint) ogsmReportStatusHint.textContent = ""; }, 3000);
        }
      } else {
        if (!hasRenderedCache) {
          ogsmReportTableBody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:15px; color:#64748b;">該區間尚無 OGSM 拜訪紀錄</td></tr>';
        }
      }
    } catch (e) {
      console.warn("載入 OGSM 月報失敗:", e);
      if (!hasRenderedCache) {
        ogsmReportTableBody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:15px; color:#ef4444;">連線失敗，無法取得 OGSM 月報數據</td></tr>';
      }
      if (ogsmReportStatusHint) {
        ogsmReportStatusHint.innerHTML = '<span style="color:#ef4444;">⚠️ 離線快取</span>';
      }
    }
  }

  function renderOgsmReportTable(records) {
    if (!ogsmReportTableBody) return;
    if (!records || records.length === 0) {
      ogsmReportTableBody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:15px; color:#64748b;">該區間尚無 OGSM 拜訪紀錄</td></tr>';
      return;
    }

    let html = "";
    records.forEach((r, rIdx) => {
      const ratingRaw = r.client_rating || "-";
      let ratingLevel = "";
      const match = ratingRaw.match(/([SABCOsabco])/i);
      if (match) ratingLevel = match[1].toUpperCase();
      const ratingClass = ratingLevel ? `rating-${ratingLevel}` : "rating-default";

      html += `
        <tr class="clickable-row" data-ogsm-row-idx="${rIdx}" title="點選直接修改此筆拜訪紀錄">
          <td class="sticky-col-client" title="${escapeHtml(r.client_name || '-')}">${escapeHtml(r.client_name || '-')}</td>
          <td style="white-space:nowrap; font-weight:600; color:#1e40af;">${escapeHtml(r.date || '-')}</td>
          <td style="white-space:nowrap; font-weight:600; text-align:center;">${escapeHtml(r.sales_name || '-')}</td>
          <td style="text-align:center;"><span class="rating-badge ${ratingClass}">${escapeHtml(ratingRaw)}</span></td>
          <td style="color:#2563eb; line-height:1.4;">${escapeHtml(r.plan_promotion || '-')}</td>
          <td style="color:#334155; line-height:1.4;">${escapeHtml(r.actual_progress || '-')}</td>
          <td style="font-size:0.75rem; color:#64748b; white-space:nowrap;">${escapeHtml(r.updated_at || '-')}</td>
        </tr>
      `;
    });

    ogsmReportTableBody.innerHTML = html;

    // 🚀 綁定點選列事件 → 於 OGSM 月報上方直接覆蓋彈出 OGSM 編輯視窗
    ogsmReportTableBody.querySelectorAll("tr[data-ogsm-row-idx]").forEach(tr => {
      tr.addEventListener("click", () => {
        const idx = parseInt(tr.dataset.ogsmRowIdx, 10);
        const record = records[idx];
        if (record) {
          openOgsmCaseEditModal(record);
        }
      });
    });
  }

  if (ogsmReportStartDate) ogsmReportStartDate.addEventListener("change", () => loadOgsmMonthlyReportData(false));
  if (ogsmReportEndDate) ogsmReportEndDate.addEventListener("change", () => loadOgsmMonthlyReportData(false));
  if (ogsmReportSalesSelect) ogsmReportSalesSelect.addEventListener("change", () => loadOgsmMonthlyReportData(false));
  if (btnRefreshOgsmReport) btnRefreshOgsmReport.addEventListener("click", () => loadOgsmMonthlyReportData(true));

  // ----------------------------------------------------
  // 3. OGSM 二級覆蓋編輯彈窗控制 (浮於 OGSM 月報之上)
  // ----------------------------------------------------
  function openOgsmCaseEditModal(record) {
    if (!ogsmCaseEditModal) return;
    if (editOgsmRowIndex) editOgsmRowIndex.value = record.row_index || "";
    if (editOgsmSalesName) editOgsmSalesName.value = record.sales_name || "";
    if (editOgsmDate) editOgsmDate.value = record.date || "";
    if (editOgsmSales) editOgsmSales.value = record.sales_name || "";
    if (editOgsmClientName) editOgsmClientName.value = record.client_name || "";
    if (editOgsmClientRating) {
      const rawRating = record.client_rating || "";
      let found = false;
      for (let i = 0; i < editOgsmClientRating.options.length; i++) {
        if (editOgsmClientRating.options[i].value === rawRating) {
          found = true;
          break;
        }
      }
      if (!found && rawRating) {
        const dynamicOpt = document.createElement("option");
        dynamicOpt.value = rawRating;
        dynamicOpt.textContent = rawRating;
        editOgsmClientRating.appendChild(dynamicOpt);
      }
      editOgsmClientRating.value = rawRating || "A";
    }
    if (editOgsmPlanPromotion) editOgsmPlanPromotion.value = record.plan_promotion || "";
    if (editOgsmActualProgress) editOgsmActualProgress.value = record.actual_progress || "";

    ogsmCaseEditModal.classList.remove("hidden");
  }

  function closeOgsmCaseEditModal() {
    if (ogsmCaseEditModal) ogsmCaseEditModal.classList.add("hidden");
  }

  if (btnCloseOgsmCaseEditModal) btnCloseOgsmCaseEditModal.addEventListener("click", closeOgsmCaseEditModal);
  if (btnCancelOgsmCaseEdit) btnCancelOgsmCaseEdit.addEventListener("click", closeOgsmCaseEditModal);

  // 點擊對話框半透明遮罩背景亦可順暢關閉
  if (ogsmCaseEditModal) {
    ogsmCaseEditModal.addEventListener("click", (e) => {
      if (e.target === ogsmCaseEditModal) {
        closeOgsmCaseEditModal();
      }
    });
  }

  if (btnSaveOgsmCaseEdit) {
    btnSaveOgsmCaseEdit.addEventListener("click", async () => {
      if (btnSaveOgsmCaseEdit.disabled) return;

      const rowIndex = editOgsmRowIndex?.value || "";
      const salesName = editOgsmSalesName?.value || getSalesName();
      const dateStr = editOgsmDate?.value || "";
      const clientName = editOgsmClientName?.value || "";
      const clientRating = editOgsmClientRating?.value || "A";
      const planPromotion = editOgsmPlanPromotion?.value?.trim() || "";
      const actualProgress = editOgsmActualProgress?.value?.trim() || "";

      if (!rowIndex || !salesName || !dateStr) {
        alert("資料不完整，無法儲存");
        return;
      }

      btnSaveOgsmCaseEdit.disabled = true;
      btnSaveOgsmCaseEdit.textContent = "⏳ 儲存中...";

      try {
        const params = new URLSearchParams({
          action: "save_ogsm",
          user_name: salesName,
          row_index: rowIndex,
          date: dateStr,
          client_name: clientName,
          client_type: clientRating,
          content: planPromotion,
          result: actualProgress
        });

        const res = await fetch(`${GAS_URL}?${params.toString()}`);
        const data = await res.json();

        if (data.status === "ok") {
          showToast("✅ OGSM 拜訪紀錄已更新", "success");
          closeOgsmCaseEditModal();
          invalidateMonthlyReportCaches();
          // 自動局部重載 OGSM 月報表格
          loadOgsmMonthlyReportData(true);
        } else {
          alert("更新失敗：" + (data.msg || "未知錯誤"));
        }
      } catch (err) {
        console.warn("更新 OGSM 失敗:", err);
        alert("連線失敗：" + err.message);
      } finally {
        btnSaveOgsmCaseEdit.disabled = false;
        btnSaveOgsmCaseEdit.textContent = "💾 儲存修改";
      }
    });
  }

  // ----------------------------------------------------
  // 4. OGSM 月報 Excel 與 PDF 匯出
  // ----------------------------------------------------
  if (btnExportOgsmExcel) {
    btnExportOgsmExcel.addEventListener("click", () => {
      if (!currentOgsmReportRecords || currentOgsmReportRecords.length === 0) {
        alert("目前無 OGSM 月報資料可供匯出");
        return;
      }

      const headers = ["客戶名稱", "拜訪日期", "業務人員", "客戶分類", "計畫推廣內容", "實際拜訪紀錄/行程", "最後更新時間"];
      const rows = currentOgsmReportRecords.map(r => [
        `"${(r.client_name || '').replace(/"/g, '""')}"`,
        `"${(r.date || '').replace(/"/g, '""')}"`,
        `"${(r.sales_name || '').replace(/"/g, '""')}"`,
        `"${(r.client_rating || '').replace(/"/g, '""')}"`,
        `"${(r.plan_promotion || '').replace(/"/g, '""')}"`,
        `"${(r.actual_progress || '').replace(/"/g, '""')}"`,
        `"${(r.updated_at || '').replace(/"/g, '""')}"`
      ]);

      const csvContent = "\uFEFF" + [headers.join(","), ...rows.map(e => e.join(","))].join("\r\n");
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.setAttribute("href", url);
      const sVal = ogsmReportStartDate?.value || "start";
      const eVal = ogsmReportEndDate?.value || "end";
      link.setAttribute("download", `OGSM商機月報_${sVal}_${eVal}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    });
  }

  if (btnExportOgsmPdf) {
    btnExportOgsmPdf.addEventListener("click", () => {
      if (!currentOgsmReportRecords || currentOgsmReportRecords.length === 0) {
        alert("目前無 OGSM 月報資料可供產出 PDF");
        return;
      }

      const sVal = ogsmReportStartDate?.value || "";
      const eVal = ogsmReportEndDate?.value || "";
      const printWin = window.open("", "_blank");
      if (!printWin) {
        alert("請允許瀏覽器快顯視窗以產出列印版");
        return;
      }

      let rowsHtml = "";
      currentOgsmReportRecords.forEach(r => {
        rowsHtml += `
          <tr>
            <td style="border:1px solid #cbd5e1; padding:6px; font-weight:bold;">${escapeHtml(r.client_name || '-')}</td>
            <td style="border:1px solid #cbd5e1; padding:6px; font-weight:bold; white-space:nowrap;">${escapeHtml(r.date || '-')}</td>
            <td style="border:1px solid #cbd5e1; padding:6px; white-space:nowrap; text-align:center;">${escapeHtml(r.sales_name || '-')}</td>
            <td style="border:1px solid #cbd5e1; padding:6px; text-align:center;">${escapeHtml(r.client_rating || '-')}</td>
            <td style="border:1px solid #cbd5e1; padding:6px;">${escapeHtml(r.plan_promotion || '-')}</td>
            <td style="border:1px solid #cbd5e1; padding:6px;">${escapeHtml(r.actual_progress || '-')}</td>
          </tr>
        `;
      });

      printWin.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>OGSM 商機月報 - ${sVal} ~ ${eVal}</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Microsoft JhengHei", sans-serif; padding: 20px; color: #0f172a; }
            h2 { margin: 0 0 4px 0; color: #1e3a8a; }
            p { margin: 0 0 16px 0; font-size: 12px; color: #64748b; }
            table { width: 100%; border-collapse: collapse; font-size: 11px; }
            th { border: 1px solid #94a3b8; background: #e2e8f0; padding: 8px 6px; font-weight: bold; text-align: left; }
            @media print {
              body { padding: 0; }
              @page { size: landscape; margin: 10mm; }
            }
          </style>
        </head>
        <body>
          <h2>📋 OGSM 團隊商機月報表 (${sVal} ~ ${eVal})</h2>
          <p>匯出時間：${new Date().toLocaleString('zh-TW')} | 總計：${currentOgsmReportRecords.length} 筆紀錄</p>
          <table>
            <thead>
              <tr>
                <th style="width:120px;">客戶名稱</th>
                <th style="width:85px;">拜訪日期</th>
                <th style="width:60px; text-align:center;">業務</th>
                <th style="width:65px; text-align:center;">客戶分類</th>
                <th>計畫推廣內容</th>
                <th>實際拜訪紀錄 / 行程</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
          <script>
            window.onload = function() { window.print(); };
          </script>
        </body>
        </html>
      `);
      printWin.document.close();
    });
  }

  // 📥 下載標準 Excel (含 UTF-8 BOM CSV，Excel 雙擊秒開無亂碼)
  if (btnExportReportExcel) {
    btnExportReportExcel.addEventListener("click", () => {
      if (!currentMonthlyReportRecords || currentMonthlyReportRecords.length === 0) {
        alert("目前無月報資料可供匯出");
        return;
      }

      const headers = ["客戶名稱", "拜訪日期", "業務人員", "案件名稱 / 拜訪目的", "預計產出", "預估金額(萬)", "正式報價單號", "案件狀況說明 (CRM備註)"];
      const rows = currentMonthlyReportRecords.map(r => {
        const visitDateStr = formatDisplayDate(r.visit_date || (r.latest_update ? r.latest_update.split(' ')[0] : ''));
        let qId = (r.quotation_id && r.quotation_id !== '-') ? r.quotation_id : '';
        if (!qId && r.dependencies) {
          const m = r.dependencies.match(/【已開立報價單：([^，】]+)/);
          if (m) qId = m[1].trim();
        }
        return [
          `"${(r.client_name || '').replace(/"/g, '""')}"`,
          `"${(visitDateStr || '').replace(/"/g, '""')}"`,
          `"${(r.sales_name || '').replace(/"/g, '""')}"`,
          `"${(r.case_name || '').replace(/"/g, '""')}"`,
          `"${(r.target_month || '').replace(/"/g, '""')}"`,
          r.estimated_amount || 0,
          `"${(qId || '').replace(/"/g, '""')}"`,
          `"${(r.status_desc || '').replace(/"/g, '""')}"`
        ];
      });

      const csvContent = "\uFEFF" + [headers.join(","), ...rows.map(e => e.join(","))].join("\r\n");
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const sVal = monthlyReportStartDate?.value || "start";
      const eVal = monthlyReportEndDate?.value || "end";
      link.setAttribute("href", url);
      link.setAttribute("download", `業務商機月報_${sVal}_${eVal}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      showToast("✅ 已成功下載 Excel 檔案 (.csv)", "success");
    });
  }

  // 🖨️ 產出 / 列印 PDF
  if (btnExportReportPdf) {
    btnExportReportPdf.addEventListener("click", () => {
      if (!currentMonthlyReportRecords || currentMonthlyReportRecords.length === 0) {
        alert("目前無月報資料可供產出 PDF");
        return;
      }

      const sVal = monthlyReportStartDate?.value || "";
      const eVal = monthlyReportEndDate?.value || "";
      const salesVal = monthlyReportSalesSelect?.value || "全體業務";

      const printWin = window.open("", "_blank");
      if (!printWin) {
        alert("請允許開啟快顯視窗以產出 PDF");
        return;
      }

      let rowsHtml = currentMonthlyReportRecords.map(r => {
        const visitDateStr = formatDisplayDate(r.visit_date || (r.latest_update ? r.latest_update.split(' ')[0] : ''));
        let qId = (r.quotation_id && r.quotation_id !== '-') ? r.quotation_id : '';
        if (!qId && r.dependencies) {
          const m = r.dependencies.match(/【已開立報價單：([^，】]+)/);
          if (m) qId = m[1].trim();
        }
        return `
        <tr>
          <td style="padding:6px; border:1px solid #cbd5e1; font-weight:bold;">${escapeHtml(r.client_name)}</td>
          <td style="padding:6px; border:1px solid #cbd5e1; white-space:nowrap; font-weight:600; color:#1e40af;">${escapeHtml(visitDateStr)}</td>
          <td style="padding:6px; border:1px solid #cbd5e1; text-align:center;">${escapeHtml(r.sales_name)}</td>
          <td style="padding:6px; border:1px solid #cbd5e1;">${escapeHtml(r.case_name || '-')}</td>
          <td style="padding:6px; border:1px solid #cbd5e1; text-align:center;">${escapeHtml(r.target_month || '-')}</td>
          <td style="padding:6px; border:1px solid #cbd5e1; text-align:right;">${r.estimated_amount ? r.estimated_amount + ' 萬' : '-'}</td>
          <td style="padding:6px; border:1px solid #cbd5e1; text-align:center; font-family:monospace;">${escapeHtml(qId || '-')}</td>
          <td style="padding:6px; border:1px solid #cbd5e1; font-size:0.8rem; color:#475569;">${escapeHtml(r.status_desc || '-')}</td>
        </tr>
      `;
      }).join("");

      printWin.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>業務商機月報 - ${sVal} ~ ${eVal}</title>
          <style>
            body { font-family: sans-serif; padding: 20px; color: #0f172a; }
            h2 { margin-bottom: 4px; }
            p { margin-top: 0; color: #64748b; font-size: 0.9rem; }
            table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-top: 15px; }
            th { background: #f1f5f9; padding: 8px 6px; border: 1px solid #cbd5e1; text-align: left; }
            @media print {
              @page { size: landscape; margin: 15mm; }
            }
          </style>
        </head>
        <body>
          <h2>📊 業務商機月報表 (${sVal} ~ ${eVal})</h2>
          <p>篩選對象：${escapeHtml(salesVal)} | 產出時間：${formatTwDateTime(new Date())}</p>
          <table>
            <thead>
              <tr>
                <th style="width:110px;">客戶名稱</th>
                <th style="width:85px; white-space:nowrap;">拜訪日期</th>
                <th style="width:65px; text-align:center;">業務</th>
                <th>案件名稱 / 拜訪目的</th>
                <th style="width:75px; text-align:center;">預計產出</th>
                <th style="width:85px; text-align:right;">預估金額</th>
                <th style="width:105px; text-align:center;">正式報價單號</th>
                <th style="width:230px;">案件狀況說明 (CRM備註)</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
          <script>
            window.onload = function() {
              window.print();
            };
          </script>
        </body>
        </html>
      `);
      printWin.document.close();
    });
  }

  // 台灣習慣時間格式化：2026/9/22 17:55
  function formatTwDateTime(val) {
    if (!val) return "";
    if (typeof val === "string") {
      const s = val.trim();
      if (/^\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}$/.test(s)) return s;
    }
    const d = new Date(val);
    if (!isNaN(d.getTime())) {
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      const day = d.getDate();
      const hr = String(d.getHours()).padStart(2, '0');
      const min = String(d.getMinutes()).padStart(2, '0');
      return `${y}/${m}/${day} ${hr}:${min}`;
    }
    const match = String(val).match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T\s]+(\d{1,2}):(\d{1,2})/);
    if (match) {
      return `${match[1]}/${parseInt(match[2], 10)}/${parseInt(match[3], 10)} ${match[4].padStart(2, '0')}:${match[5].padStart(2, '0')}`;
    }
    return String(val);
  }

  // ====================================================
  // 本機日報歷史快照管理模組 (上限 10 筆，保存 180 天)
  // ====================================================
  let currentEditingOriginalItem = null;

  function getLocalOgsmHistory(dateStr, clientName) {
    if (!dateStr || !clientName) return [];
    try {
      const key = `ogsm_hist_${dateStr}_${clientName}`;
      const json = localStorage.getItem(key);
      if (!json) return [];
      const list = JSON.parse(json);
      if (!Array.isArray(list)) return [];
      const now = Date.now();
      return list.filter(item => {
        const t = item.created_ms || (item.timestamp ? new Date(item.timestamp.replace(/-/g, "/")).getTime() : 0);
        return t > 0 ? (now - t) <= (180 * 86400000) : true;
      });
    } catch (e) {
      return [];
    }
  }

  function saveLocalOgsmHistory(dateStr, clientName, snapshot) {
    if (!dateStr || !clientName || !snapshot) return;
    try {
      const key = `ogsm_hist_${dateStr}_${clientName}`;
      let list = getLocalOgsmHistory(dateStr, clientName);
      list.push(snapshot);
      if (list.length > 10) {
        list = list.slice(list.length - 10);
      }
      localStorage.setItem(key, JSON.stringify(list));
    } catch (e) {
      console.warn("[OGSM] 本機歷史快照儲存失敗:", e);
    }
  }

  // 取得勾選之推廣產品複選字串
  function getSelectedOgsmProducts() {
    const checked = document.querySelectorAll('input[name="ogsm_product"]:checked');
    return Array.from(checked).map(cb => cb.value).join(", ");
  }

  // 折疊手風琴與推廣產品全選監聽
  if (btnToggleOgsmExtraFields && ogsmExtraFieldsBody) {
    btnToggleOgsmExtraFields.addEventListener("click", () => {
      const isHidden = ogsmExtraFieldsBody.classList.toggle("hidden");
      if (ogsmExtraArrow) {
        ogsmExtraArrow.textContent = isHidden ? "▼ 展開" : "▲ 收合";
      }
    });
  }

  if (btnToggleAllOgsmProducts) {
    btnToggleAllOgsmProducts.addEventListener("click", () => {
      const cbs = document.querySelectorAll('input[name="ogsm_product"]');
      const allChecked = Array.from(cbs).every(cb => cb.checked);
      cbs.forEach(cb => { cb.checked = !allChecked; });
    });
  }

  // ====================================================
  // 日報新增與編輯表單控制
  // ====================================================
  function openOgsmEditModal(dateStr, itemToEdit = null) {
    if (!ogsmEditModal || !ogsmInputDate) return;

    // 填入當前登入業務人員姓名
    const currentSales = getSalesName();
    if (ogsmInputUser) ogsmInputUser.value = currentSales;

    // 動態填入「客戶所屬（偕同拜訪/擔當）」人員名單
    if (ogsmInputClientOwner) {
      const selectedOwner = (itemToEdit && itemToEdit.client_owner) ? itemToEdit.client_owner : "";
      ogsmInputClientOwner.innerHTML = `<option value="">-- 請選擇人員（選填） --</option>`
        + ALL_SALES_MEMBERS.map(m => `<option value="${m}" ${m === selectedOwner ? "selected" : ""}>${m}</option>`).join("");
    }

    if (itemToEdit) {
      currentEditingOriginalItem = {
        date: itemToEdit.date || dateStr,
        client_name: itemToEdit.client_name || "",
        client_type: itemToEdit.client_type || "",
        content: itemToEdit.content || "",
        result: itemToEdit.result || "",
        row_index: itemToEdit.row_index || "",
        offline_id: itemToEdit.offline_id || "",
        client_owner: itemToEdit.client_owner || "",
        industry: itemToEdit.industry || "",
        channel: itemToEdit.channel || "",
        comp_channel: itemToEdit.comp_channel || "",
        action_plan: itemToEdit.action_plan || "",
        is_lost_retrieved: itemToEdit.is_lost_retrieved || "",
        promoted_products: itemToEdit.promoted_products || "",
        expected_month: itemToEdit.expected_month || "",
        competing_brand: itemToEdit.competing_brand || "",
        estimated_amount: itemToEdit.estimated_amount || "0.0",
        dependencies: itemToEdit.dependencies || "",
        history: itemToEdit.history || ""
      };
      if (ogsmEditModalTitle) ogsmEditModalTitle.textContent = "✏️ 編輯業務日報";
      if (ogsmEditRowIndex) ogsmEditRowIndex.value = itemToEdit.row_index || "";
      if (ogsmEditOfflineId) ogsmEditOfflineId.value = itemToEdit.offline_id || "";
      ogsmInputDate.value = itemToEdit.date || dateStr;
      if (ogsmInputClient) ogsmInputClient.value = itemToEdit.client_name || "";
      if (ogsmSelectType) ogsmSelectType.value = itemToEdit.client_type || "";
      if (ogsmInputContent) ogsmInputContent.value = itemToEdit.content || "";
      if (ogsmInputResult) ogsmInputResult.value = itemToEdit.result || "";

      // 填入 11 項商機詳細欄位
      if (ogsmInputIndustry) ogsmInputIndustry.value = itemToEdit.industry || "";
      if (ogsmInputChannel) ogsmInputChannel.value = itemToEdit.channel || "";
      if (ogsmInputCompChannel) ogsmInputCompChannel.value = itemToEdit.comp_channel || "無";
      if (ogsmInputActionPlan) ogsmInputActionPlan.value = itemToEdit.action_plan || "出差到客戶端拜訪";
      if (ogsmInputLostRetrieved) ogsmInputLostRetrieved.value = itemToEdit.is_lost_retrieved || "無";
      if (ogsmInputExpectedMonth) ogsmInputExpectedMonth.value = itemToEdit.expected_month || "";
      if (ogsmInputCompetingBrand) ogsmInputCompetingBrand.value = itemToEdit.competing_brand || "台灣品牌";
      if (ogsmInputEstimatedAmount) ogsmInputEstimatedAmount.value = (itemToEdit.estimated_amount !== undefined && itemToEdit.estimated_amount !== null && String(itemToEdit.estimated_amount).trim() !== "") ? itemToEdit.estimated_amount : "0.0";
      if (ogsmInputDependencies) ogsmInputDependencies.value = itemToEdit.dependencies || "";

      // 勾選推廣產品
      const selectedProducts = (itemToEdit.promoted_products || "").split(/[,，、]+/).map(s => s.trim()).filter(Boolean);
      document.querySelectorAll('input[name="ogsm_product"]').forEach(cb => {
        cb.checked = selectedProducts.some(p => cb.value.includes(p) || p.includes(cb.value));
      });

      // 若有商機資料則自動展開折疊區塊，否則保持收合
      const hasExtraData = !!(itemToEdit.client_owner || itemToEdit.industry || itemToEdit.channel || (itemToEdit.comp_channel && itemToEdit.comp_channel !== "無") || itemToEdit.expected_month || (itemToEdit.estimated_amount && parseFloat(itemToEdit.estimated_amount) > 0) || itemToEdit.dependencies || selectedProducts.length > 0);
      if (hasExtraData) {
        if (ogsmExtraFieldsBody) ogsmExtraFieldsBody.classList.remove("hidden");
        if (ogsmExtraArrow) ogsmExtraArrow.textContent = "▲ 收合";
      } else {
        if (ogsmExtraFieldsBody) ogsmExtraFieldsBody.classList.add("hidden");
        if (ogsmExtraArrow) ogsmExtraArrow.textContent = "▼ 展開";
      }

      if (itemToEdit.history && ogsmHistorySection && ogsmHistoryText) {
        ogsmHistoryText.textContent = itemToEdit.history;
        ogsmHistorySection.classList.remove("hidden");
      } else if (ogsmHistorySection) {
        ogsmHistorySection.classList.add("hidden");
      }
    } else {
      currentEditingOriginalItem = null;
      if (ogsmEditModalTitle) ogsmEditModalTitle.textContent = "✍️ 填寫業務日報";
      if (ogsmEditRowIndex) ogsmEditRowIndex.value = "";
      if (ogsmEditOfflineId) ogsmEditOfflineId.value = "";
      ogsmInputDate.value = dateStr || new Date().toISOString().split("T")[0];
      if (ogsmInputClient) ogsmInputClient.value = "";
      if (ogsmSelectType) ogsmSelectType.value = "";
      if (ogsmInputContent) ogsmInputContent.value = "";
      if (ogsmInputResult) ogsmInputResult.value = "";

      // 重設 11 項商機詳細欄位為預設值
      if (ogsmInputIndustry) ogsmInputIndustry.value = "";
      if (ogsmInputChannel) ogsmInputChannel.value = "";
      if (ogsmInputCompChannel) ogsmInputCompChannel.value = "無";
      if (ogsmInputActionPlan) ogsmInputActionPlan.value = "出差到客戶端拜訪";
      if (ogsmInputLostRetrieved) ogsmInputLostRetrieved.value = "無";
      if (ogsmInputExpectedMonth) ogsmInputExpectedMonth.value = "";
      if (ogsmInputCompetingBrand) ogsmInputCompetingBrand.value = "台灣品牌";
      if (ogsmInputEstimatedAmount) ogsmInputEstimatedAmount.value = "0.0";
      if (ogsmInputDependencies) ogsmInputDependencies.value = "";
      document.querySelectorAll('input[name="ogsm_product"]').forEach(cb => { cb.checked = false; });

      // 新增時預設收合折疊區塊，維持極速填報動線
      if (ogsmExtraFieldsBody) ogsmExtraFieldsBody.classList.add("hidden");
      if (ogsmExtraArrow) ogsmExtraArrow.textContent = "▼ 展開";

      if (ogsmHistorySection) ogsmHistorySection.classList.add("hidden");
    }

    if (ogsmClientAutocomplete) ogsmClientAutocomplete.classList.add("hidden");

    ogsmEditModal.classList.remove("hidden");
    setTimeout(() => {
      if (ogsmInputClient) ogsmInputClient.focus();
    }, 150);
  }

  function closeOgsmEditModal() {
    if (ogsmEditModal) ogsmEditModal.classList.add("hidden");
    if (ogsmClientAutocomplete) ogsmClientAutocomplete.classList.add("hidden");
  }

  if (btnCloseOgsmEditModal) btnCloseOgsmEditModal.addEventListener("click", closeOgsmEditModal);
  if (btnCancelOgsmEdit) btnCancelOgsmEdit.addEventListener("click", closeOgsmEditModal);

  // 客戶名稱輸入時觸發即時關鍵字模糊快選
  if (ogsmInputClient && ogsmClientAutocomplete) {
    ogsmInputClient.addEventListener("input", () => {
      const val = ogsmInputClient.value.trim().toLowerCase();
      if (!val) {
        ogsmClientAutocomplete.classList.add("hidden");
        return;
      }

      const matches = MOCK_CUSTOMERS.filter(c => {
        const name = (c.name || "").toLowerCase();
        const comp = (c.company_name || "").toLowerCase();
        const code = (c.customer_code || "").toLowerCase();
        return name.includes(val) || comp.includes(val) || code.includes(val);
      }).slice(0, 6);

      if (matches.length === 0) {
        ogsmClientAutocomplete.classList.add("hidden");
        return;
      }

      ogsmClientAutocomplete.innerHTML = matches.map(m => {
        const displayName = m.company_name ? `${m.name} <span style="font-size:0.8rem; color:#64748b;">(${m.company_name})</span>` : m.name;
        return `<div class="autocomplete-item" data-name="${encodeURIComponent(m.name)}">${displayName}</div>`;
      }).join("");

      ogsmClientAutocomplete.classList.remove("hidden");

      // 綁定選項點擊帶入
      ogsmClientAutocomplete.querySelectorAll(".autocomplete-item").forEach(item => {
        item.addEventListener("click", () => {
          const selectedName = decodeURIComponent(item.dataset.name);
          ogsmInputClient.value = selectedName;
          ogsmClientAutocomplete.classList.add("hidden");
        });
      });
    });
  }

  // 儲存日報至後端 GAS (樂觀更新 Optimistic Update + 背景非同步傳送 + 防重複鎖)
  if (btnSaveOgsmEdit) {
    btnSaveOgsmEdit.addEventListener("click", async () => {
      if (btnSaveOgsmEdit.disabled) return; // 防連點鎖

      const dateStr = ogsmInputDate.value;
      const clientName = (ogsmInputClient.value || "").trim();
      const clientType = ogsmSelectType.value;
      const content = (ogsmInputContent.value || "").trim();
      const result = (ogsmInputResult.value || "").trim();

      if (!clientName) {
        alert("請輸入客戶名稱");
        ogsmInputClient.focus();
        return;
      }
      if (!clientType) {
        alert("請選擇客戶分類");
        ogsmSelectType.focus();
        return;
      }

      const salesName = getSalesName();
      const editingRowIndex = ogsmEditRowIndex ? ogsmEditRowIndex.value : "";
      const editingOfflineId = ogsmEditOfflineId ? ogsmEditOfflineId.value : "";

      // 採集 11 個商機詳細欄位
      const clientOwner = ogsmInputClientOwner ? ogsmInputClientOwner.value : "";
      const industry = ogsmInputIndustry ? ogsmInputIndustry.value : "";
      const channel = ogsmInputChannel ? ogsmInputChannel.value : "";
      const compChannel = ogsmInputCompChannel ? ogsmInputCompChannel.value : "";
      const actionPlan = ogsmInputActionPlan ? ogsmInputActionPlan.value : "";
      const isLostRetrieved = ogsmInputLostRetrieved ? ogsmInputLostRetrieved.value : "";
      const promotedProducts = getSelectedOgsmProducts();
      const expectedMonth = ogsmInputExpectedMonth ? ogsmInputExpectedMonth.value : "";
      const competingBrand = ogsmInputCompetingBrand ? ogsmInputCompetingBrand.value : "";
      const estimatedAmount = ogsmInputEstimatedAmount ? (ogsmInputEstimatedAmount.value || "0.0") : "0.0";
      const dependencies = ogsmInputDependencies ? ogsmInputDependencies.value.trim() : "";

      // 1. 防重複點擊鎖定
      btnSaveOgsmEdit.disabled = true;

      const payload = {
        user_name: salesName,
        date: dateStr,
        client_name: clientName,
        client_type: clientType,
        content: content,
        result: result,
        client_owner: clientOwner,
        industry: industry,
        channel: channel,
        comp_channel: compChannel,
        action_plan: actionPlan,
        is_lost_retrieved: isLostRetrieved,
        promoted_products: promotedProducts,
        expected_month: expectedMonth,
        competing_brand: competingBrand,
        estimated_amount: estimatedAmount,
        dependencies: dependencies,
        is_test: isTestMode ? "1" : "0"
      };
      if (editingRowIndex) {
        payload.row_index = editingRowIndex;
      }

      // 若為編輯現有日報，且資料有異動，立即在本地建立舊資料快照（保留具體實體內容）
      if (currentEditingOriginalItem && (editingRowIndex || editingOfflineId)) {
        const oldClient = currentEditingOriginalItem.client_name || "";
        const oldType = currentEditingOriginalItem.client_type || "";
        const oldContent = currentEditingOriginalItem.content || "";
        const oldResult = currentEditingOriginalItem.result || "";

        const hasChanged = (oldClient !== clientName || oldType !== clientType || oldContent !== content || oldResult !== result);
        if (hasChanged) {
          const now = new Date();
          const timeStr = formatTwDateTime(now);

          const changeList = [];
          if (oldClient !== clientName) changeList.push(`客戶：「${oldClient}」➔「${clientName}」`);
          if (oldType !== clientType) changeList.push(`分類：「${oldType}」➔「${clientType}」`);
          if (oldContent !== content) changeList.push("工作內容修訂");
          if (oldResult !== result) changeList.push("實際行程修訂");

          const snapshot = {
            timestamp: timeStr,
            created_ms: now.getTime(),
            editor: salesName,
            summary: changeList.join("、") || "資料修訂",
            old_data: {
              client_name: oldClient,
              client_type: oldType,
              content: oldContent,
              result: oldResult
            }
          };

          saveLocalOgsmHistory(dateStr, clientName, snapshot);
          if (oldClient && oldClient !== clientName) {
            saveLocalOgsmHistory(dateStr, oldClient, snapshot);
          }
        }
      }

      // 2. 建立樂觀暫存物件（Optimistic Update）
      const tempId = "sync_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);
      const optimisticItem = {
        temp_id: tempId,
        row_index: editingRowIndex,
        offline_id: editingOfflineId,
        date: dateStr,
        client_name: clientName,
        client_type: clientType,
        content: content,
        result: result,
        client_owner: clientOwner,
        industry: industry,
        channel: channel,
        comp_channel: compChannel,
        action_plan: actionPlan,
        is_lost_retrieved: isLostRetrieved,
        promoted_products: promotedProducts,
        expected_month: expectedMonth,
        competing_brand: competingBrand,
        estimated_amount: estimatedAmount,
        dependencies: dependencies,
        is_syncing: true,
        updated_at: formatTwDateTime(new Date())
      };

      // 3. 立即關閉表單（0 延遲體驗，使用者完全不需等待）
      closeOgsmEditModal();
      btnSaveOgsmEdit.disabled = false; // 解除按鈕鎖定

      // 4. 加入同步中佇列並立即更新介面
      ogsmSyncingReports.push(optimisticItem);
      ogsmDatesWithReports.add(dateStr);
      renderCalendar(ogsmCurrentYear, ogsmCurrentMonth);

      // 重新渲染當日檢視視窗
      currentViewingDate = dateStr;
      refreshCurrentDayModal();

      showToast(`⏳「${clientName}」日報已保存，背景同步中...`, "info");

      // 5. 於背景非同步發送雲端請求
      executeSaveOgsmInBackground(payload, tempId, editingRowIndex, editingOfflineId);
    });
  }

  // 🚀 「儲存並轉入 CRM」按鈕：先儲存日報，成功後自動彈出 CRM 直式編輯表單
  if (btnSaveOgsmAndCrm) {
    btnSaveOgsmAndCrm.addEventListener("click", async () => {
      if (btnSaveOgsmAndCrm.disabled) return;

      const dateStr = ogsmInputDate.value;
      const clientName = (ogsmInputClient.value || "").trim();
      const clientType = ogsmSelectType.value;
      const content = (ogsmInputContent.value || "").trim();
      const result = (ogsmInputResult.value || "").trim();

      if (!clientName) {
        alert("請輸入客戶名稱");
        ogsmInputClient.focus();
        return;
      }
      if (!clientType) {
        alert("請選擇客戶分類");
        ogsmSelectType.focus();
        return;
      }

      const salesName = getSalesName();
      const editingRowIndex = ogsmEditRowIndex ? ogsmEditRowIndex.value : "";

      // 採集 11 個商機詳細欄位
      const clientOwner = ogsmInputClientOwner ? ogsmInputClientOwner.value : "";
      const industry = ogsmInputIndustry ? ogsmInputIndustry.value : "";
      const channel = ogsmInputChannel ? ogsmInputChannel.value : "";
      const compChannel = ogsmInputCompChannel ? ogsmInputCompChannel.value : "";
      const actionPlan = ogsmInputActionPlan ? ogsmInputActionPlan.value : "";
      const isLostRetrieved = ogsmInputLostRetrieved ? ogsmInputLostRetrieved.value : "";
      const promotedProducts = getSelectedOgsmProducts();
      const expectedMonth = ogsmInputExpectedMonth ? ogsmInputExpectedMonth.value : "";
      const competingBrand = ogsmInputCompetingBrand ? ogsmInputCompetingBrand.value : "";
      const estimatedAmount = ogsmInputEstimatedAmount ? (ogsmInputEstimatedAmount.value || "0.0") : "0.0";
      const dependencies = ogsmInputDependencies ? ogsmInputDependencies.value.trim() : "";

      // 防重複點擊
      btnSaveOgsmAndCrm.disabled = true;
      btnSaveOgsmAndCrm.textContent = "⏳ 儲存中...";

      const payload = {
        user_name: salesName,
        date: dateStr,
        client_name: clientName,
        client_type: clientType,
        content: content,
        result: result,
        client_owner: clientOwner,
        industry: industry,
        channel: channel,
        comp_channel: compChannel,
        action_plan: actionPlan,
        is_lost_retrieved: isLostRetrieved,
        promoted_products: promotedProducts,
        expected_month: expectedMonth,
        competing_brand: competingBrand,
        estimated_amount: estimatedAmount,
        dependencies: dependencies,
        is_test: isTestMode ? "1" : "0"
      };
      if (editingRowIndex) payload.row_index = editingRowIndex;

      try {
        const params = new URLSearchParams(payload);
        params.append("action", "save_ogsm");
        const res = await fetch(`${GAS_URL}?${params.toString()}`);
        const data = await res.json();

        if (data.status === "ok") {
          showToast(`✅「${clientName}」日報已儲存`, "success");
          closeOgsmEditModal();

          // 重新整理月曆
          ogsmDatesWithReports.add(dateStr);
          renderCalendar(ogsmCurrentYear, ogsmCurrentMonth);
          refreshCurrentDayModal();

          // 🚀 自動帶出 CRM 直式編輯表單（完整預填日報與商機選單資料）
          const crmRecord = {
            row_index: null,   // 新建 CRM，稍後由 sync_ogsm_to_crm 建立
            client_name: clientName,
            client_owner: clientOwner || salesName,
            case_name: content,
            promoted_products: promotedProducts,
            target_month: expectedMonth,
            estimated_amount: parseFloat(estimatedAmount) || 0,
            status_desc: result,
            competing_brand: competingBrand,
            dependencies: dependencies,
            visit_date: dateStr,
            industry: industry,
            channel: channel,
            comp_channel: compChannel,
            client_nature: clientType,
            is_lost_retrieved: isLostRetrieved,
            action_plan: actionPlan
          };
          openCrmEditModal(crmRecord, "ogsm_save");
        } else {
          alert("儲存日報失敗：" + (data.msg || "未知錯誤"));
        }
      } catch (err) {
        console.error("儲存日報並轉 CRM 失敗:", err);
        alert("儲存日報失敗，請檢查網路連線。");
      } finally {
        btnSaveOgsmAndCrm.disabled = false;
        btnSaveOgsmAndCrm.textContent = "💾 儲存並轉入 CRM";
      }
    });
  }

  // ====================================================
  // 🚀 CRM 商機直式編輯表單：開啟 / 儲存 / 關閉
  // ====================================================

  function openCrmEditModal(record, source) {
    if (!crmEditModal) return;
    crmEditSource = source || null;

    // 填入資料
    if (crmEditRowIndex) crmEditRowIndex.value = record.row_index || "";
    if (crmEditClientName) crmEditClientName.value = record.client_name || "";
    if (crmEditCaseName) crmEditCaseName.value = record.case_name || "";
    if (crmEditProducts) crmEditProducts.value = record.promoted_products || "";
    if (crmEditExpectedMonth) crmEditExpectedMonth.value = record.target_month || "";
    if (crmEditAmount) crmEditAmount.value = record.estimated_amount || "";
    if (crmEditStatusDesc) crmEditStatusDesc.value = record.status_desc || "";
    if (crmEditBrand) crmEditBrand.value = record.competing_brand || "";
    if (crmEditDependencies) crmEditDependencies.value = record.dependencies || "";
    if (crmEditVisitDate) crmEditVisitDate.value = record.visit_date ? formatDisplayDate(record.visit_date) : "";
    if (crmEditIndustry) crmEditIndustry.value = record.industry || "";
    if (crmEditChannel) crmEditChannel.value = record.channel || "";
    if (crmEditClientNature) populateClientNatureOptions(crmEditClientNature, record.client_nature || "");
    if (crmEditLostRetrieved) crmEditLostRetrieved.value = record.is_lost_retrieved || "";
    if (crmEditActionPlan) crmEditActionPlan.value = record.action_plan || "";

    // 綁定當前編輯紀錄供標記不聯繫使用
    activeCrmEditRecord = record;

    // 客戶所屬下拉選項
    if (crmEditClientOwner) {
      const currentOwner = record.client_owner || "";
      crmEditClientOwner.innerHTML = `<option value="">-- 請選擇 --</option>`
        + ALL_SALES_MEMBERS.map(m => `<option value="${m}" ${m === currentOwner ? "selected" : ""}>${m}</option>`).join("");
    }

    // 標題調整
    if (crmEditModalTitle) {
      crmEditModalTitle.textContent = record.row_index ? "📝 編輯 CRM 商機" : "📝 新建 CRM 商機";
    }
    if (crmEditModalSubtitle) {
      crmEditModalSubtitle.textContent = record.row_index
        ? `修改後將即時回寫至 CRM 試算表（第 ${record.row_index} 列）`
        : "填寫後將新增至 CRM 試算表";
    }

    crmEditModal.classList.remove("hidden");
  }

  function closeCrmEditModal() {
    if (crmEditModal) crmEditModal.classList.add("hidden");
    crmEditSource = null;
  }

  if (btnCloseCrmEditModal) btnCloseCrmEditModal.addEventListener("click", closeCrmEditModal);
  if (btnCancelCrmEdit) btnCancelCrmEdit.addEventListener("click", closeCrmEditModal);

  // CRM 儲存邏輯
  if (btnSaveCrmEdit) {
    btnSaveCrmEdit.addEventListener("click", async () => {
      if (btnSaveCrmEdit.disabled) return;

      const rowIndex = crmEditRowIndex ? crmEditRowIndex.value : "";
      const clientName = (crmEditClientName ? crmEditClientName.value : "").trim();
      const clientOwner = crmEditClientOwner ? crmEditClientOwner.value : "";
      const caseName = crmEditCaseName ? crmEditCaseName.value.trim() : "";
      const products = crmEditProducts ? crmEditProducts.value.trim() : "";
      const expectedMonth = crmEditExpectedMonth ? crmEditExpectedMonth.value.trim() : "";
      const amount = crmEditAmount ? crmEditAmount.value : "0";
      const statusDesc = crmEditStatusDesc ? crmEditStatusDesc.value.trim() : "";
      const brand = crmEditBrand ? crmEditBrand.value.trim() : "";
      const dependencies = crmEditDependencies ? crmEditDependencies.value.trim() : "";
      const visitDate = crmEditVisitDate ? crmEditVisitDate.value.trim() : "";
      const industry = crmEditIndustry ? crmEditIndustry.value.trim() : "";
      const channel = crmEditChannel ? crmEditChannel.value.trim() : "";
      const compChannel = crmEditCompChannel ? crmEditCompChannel.value.trim() : "";
      const clientNature = crmEditClientNature ? crmEditClientNature.value.trim() : "";
      const isLostRetrieved = crmEditLostRetrieved ? crmEditLostRetrieved.value.trim() : "";
      const actionPlan = crmEditActionPlan ? crmEditActionPlan.value.trim() : "";

      if (!clientName) {
        alert("客戶名稱為必填");
        return;
      }

      btnSaveCrmEdit.disabled = true;
      btnSaveCrmEdit.textContent = "⏳ 儲存中...";

      try {
        if (rowIndex) {
          // 既有列 → 呼叫 update_crm_case_detail
          const params = new URLSearchParams({
            action: "update_crm_case_detail",
            row_index: rowIndex,
            client_name: clientName,
            client_owner: clientOwner,
            case_name: caseName,
            promoted_products: products,
            expected_month: expectedMonth,
            estimated_amount: amount,
            status_desc: statusDesc,
            competing_brand: brand,
            dependencies: dependencies,
            visit_date: visitDate,
            industry: industry,
            channel: channel,
            comp_channel: compChannel,
            client_nature: clientNature,
            is_lost_retrieved: isLostRetrieved,
            action_plan: actionPlan
          });

          const res = await fetch(`${GAS_URL}?${params.toString()}`);
          const data = await res.json();

          if (data.status === "ok") {
            showToast(data.msg || "✅ CRM 商機已更新", "success");
            closeCrmEditModal();
            invalidateMonthlyReportCaches();
            // 若來源為月報，自動重新載入月報
            if (crmEditSource === "monthly_report" && typeof loadMonthlyReportData === "function") {
              loadMonthlyReportData(true);
            }
          } else {
            alert("更新失敗：" + (data.msg || "未知錯誤"));
          }
        } else {
          // 無 row_index → 新建 CRM（呼叫 sync_ogsm_to_crm）
          const salesName = getSalesName();
          const params = new URLSearchParams({
            action: "sync_ogsm_to_crm",
            user_name: salesName,
            client_name: clientName,
            client_owner: clientOwner || salesName,
            purpose_or_project: caseName,
            status_description: statusDesc,
            promoted_products: products,
            expected_month: expectedMonth,
            estimated_amount: amount,
            competing_brand: brand,
            dependencies: dependencies,
            visit_date: visitDate,
            industry: industry,
            channel: channel,
            comp_channel: compChannel,
            client_nature: clientNature,
            is_lost_retrieved: isLostRetrieved,
            action_plan: actionPlan
          });

          const res = await fetch(`${GAS_URL}?${params.toString()}`);
          const data = await res.json();

          if (data.status === "ok") {
            showToast(data.msg || "✅ 已新增至 CRM 試算表", "success");
            closeCrmEditModal();
            invalidateMonthlyReportCaches();
          } else {
            alert("新增 CRM 失敗：" + (data.msg || "未知錯誤"));
          }
        }
      } catch (err) {
        console.error("CRM 儲存失敗:", err);
        alert("CRM 儲存失敗，請檢查網路連線。");
      } finally {
        btnSaveCrmEdit.disabled = false;
        btnSaveCrmEdit.textContent = "💾 儲存修改";
      }
    });
  }

  // 背景非同步發送函式
  async function executeSaveOgsmInBackground(payload, tempId, editingRowIndex, editingOfflineId) {
    try {
      const params = new URLSearchParams(payload);
      params.append("action", "save_ogsm");

      const res = await fetch(`${GAS_URL}?${params.toString()}`, {
        method: "GET",
        headers: { "Accept": "application/json" }
      });
      const data = await res.json();

      if (data.status !== "ok" || !data.entry) {
        throw new Error(data.msg || "雲端伺服器回應異常");
      }

      if (data.spreadsheet_id) {
        console.log("[OGSM] 試算表 ID:", data.spreadsheet_id);
      }

      // 同步成功：自 syncing 佇列移除
      ogsmSyncingReports = ogsmSyncingReports.filter(r => r.temp_id !== tempId);

      // 若原為離線暫存則清理
      if (editingOfflineId) {
        removeOfflineOgsmDraft(editingOfflineId);
      }
      cleanDuplicateOfflineDrafts(payload.date, payload.client_name);

      // 重新讀取雲端最新當月資料
      await loadOgsmMonthly(ogsmCurrentYear, ogsmCurrentMonth);
      invalidateMonthlyReportCaches();

      if (currentViewingDate === payload.date) {
        refreshCurrentDayModal();
      }

      showToast(`✅「${payload.client_name}」日報已成功同步至雲端！`, "success");

    } catch (err) {
      console.warn("[OGSM] 背景同步失敗，轉為本機離線暫存:", err);
      // 同步失敗：自 syncing 移除，存入本機離線佇列
      ogsmSyncingReports = ogsmSyncingReports.filter(r => r.temp_id !== tempId);

      if (editingOfflineId) {
        updateOfflineOgsmDraft(editingOfflineId, payload);
      } else {
        saveToOfflineOgsmDrafts(payload);
      }

      if (currentViewingDate === payload.date) {
        refreshCurrentDayModal();
      }

      showToast(`⚠️「${payload.client_name}」網路逾時，已轉為離線暫存`, "warning");
    }
  }

  // 自訂確認對話框 (免受瀏覽器阻擋)
  function showConfirmModal(message, onConfirm) {
    if (!ogsmConfirmModal) {
      if (confirm(message)) onConfirm();
      return;
    }
    if (ogsmConfirmMsg) ogsmConfirmMsg.textContent = message;
    ogsmConfirmModal.classList.remove("hidden");

    const cleanup = () => {
      ogsmConfirmModal.classList.add("hidden");
      btnCancelConfirm.removeEventListener("click", onCancel);
      btnExecuteConfirm.removeEventListener("click", onExec);
    };

    const onCancel = () => cleanup();
    const onExec = () => {
      cleanup();
      onConfirm();
    };

    btnCancelConfirm.addEventListener("click", onCancel);
    btnExecuteConfirm.addEventListener("click", onExec);
  }

  // 自訂歷史紀錄檢視對話框 (支援本機快照、雲端獨立 JSON 庫舊資料快照與相容解析)
  async function showHistoryModal(clientName, historyText, dateStr) {
    if (!ogsmHistoryModal || !ogsmHistoryModalList) return;
    if (ogsmHistoryModalTitle) ogsmHistoryModalTitle.textContent = `📜 ${clientName} - 變更歷史紀錄`;

    ogsmHistoryModalList.innerHTML = `<div style="text-align:center; padding:1.2rem; color:#64748b;">⏳ 正在載入歷史版本快照...</div>`;
    ogsmHistoryModal.classList.remove("hidden");

    // 1. 先抓取本機儲存之歷史快照 (0 延遲，最即時)
    const localList = getLocalOgsmHistory(dateStr, clientName);
    let cloudList = [];

    // 2. 嘗試自 GAS 獨立歷史庫讀取 (ogsm_history.json)
    try {
      const caseKey = `${dateStr}_${clientName}`;
      const params = new URLSearchParams({
        action: "get_ogsm_history",
        case_key: caseKey,
        date: dateStr,
        client_name: clientName
      });

      const res = await fetch(`${GAS_URL}?${params.toString()}`);
      const data = await res.json();

      if (data.status === "ok" && Array.isArray(data.history)) {
        cloudList = data.history;
      }
    } catch (e) {
      console.warn("[OGSM] 雲端歷史庫讀取異常:", e);
    }

    // 3. 合併本機與雲端歷史快照 (依 timestamp 去除重複)
    const combined = [...localList];
    cloudList.forEach(ch => {
      const exists = combined.some(lh => lh.timestamp === ch.timestamp);
      if (!exists) combined.push(ch);
    });

    // 4. 若上述皆無快照，但試算表第 9 欄有文字 (向下相容解析舊資料)
    if (combined.length === 0 && historyText) {
      const lines = historyText.trim().split("\n").filter(Boolean);
      lines.forEach(line => {
        const match = line.match(/^\[(.*?)\s+(.*?)\]\s*(.*)$/);
        if (match) {
          const t = match[1];
          const ed = match[2];
          const raw = match[3];

          let parsedContent = "";
          let parsedResult = "";
          let parsedType = "";

          const mContent = raw.match(/原工作內容:\s*「(.*?)」/);
          if (mContent) parsedContent = mContent[1];
          const mResult = raw.match(/原實際行程:\s*「(.*?)」/);
          if (mResult) parsedResult = mResult[1];
          const mType = raw.match(/原分類:\s*「(.*?)」/);
          if (mType) parsedType = mType[1];

          if (parsedContent || parsedResult || parsedType) {
            combined.push({
              timestamp: t,
              editor: ed,
              summary: "歷史修訂資料",
              old_data: {
                client_type: parsedType || "未變更",
                content: parsedContent || "未變更",
                result: parsedResult || "未變更"
              }
            });
          } else {
            combined.push({
              timestamp: t,
              editor: ed,
              summary: raw,
              legacy_note: "此筆紀錄為歷史快照機制啟用前之早期異動紀錄（早期僅記載狀態變更：" + raw + "）",
              old_data: {
                client_type: "(早期紀錄未留存快照)",
                content: "(早期紀錄未留存快照)",
                result: "(早期紀錄未留存快照)"
              }
            });
          }
        }
      });
    }

    if (combined.length === 0) {
      ogsmHistoryModalList.innerHTML = `<div class="ogsm-empty-tip">此日報目前尚無歷史修改紀錄。</div>`;
      return;
    }

    // 依時間由新至舊排序
    combined.sort((a, b) => {
      const tA = a.created_ms || new Date((a.timestamp || "").replace(/-/g, "/")).getTime() || 0;
      const tB = b.created_ms || new Date((b.timestamp || "").replace(/-/g, "/")).getTime() || 0;
      return tB - tA;
    });

    // 渲染為完全展開呈現之實體歷史資料卡
    let cardsHtml = "";
    combined.forEach(h => {
      const old = h.old_data || {};
      cardsHtml += `
        <div class="history-entry-card">
          <div class="history-entry-header-open">
            <div class="history-entry-meta">
              <span>📅 ${escapeHtml(formatTwDateTime(h.timestamp))}</span>
              <span class="history-editor">[${escapeHtml(h.editor || '業務')}]</span>
            </div>
            <span class="history-badge">${escapeHtml(h.summary || '修訂前快照')}</span>
          </div>
          <div class="history-entry-body">
            <div class="history-field-box">
              <div class="history-field-title">📌 修改前客戶分類：</div>
              <div class="history-field-content type-field">${escapeHtml(old.client_type || '無')}</div>
            </div>
            <div class="history-field-box">
              <div class="history-field-title">📝 修改前工作內容：</div>
              <div class="history-field-content">${escapeHtml(old.content || '無')}</div>
            </div>
            <div class="history-field-box">
              <div class="history-field-title">🎯 修改前實際行程：</div>
              <div class="history-field-content result-field">${escapeHtml(old.result || '無')}</div>
            </div>
            ${h.legacy_note ? `<div style="margin-top:6px; padding:6px 8px; background:#fff1f2; border:1px solid #fecdd3; border-radius:4px; font-size:0.75rem; color:#be123c;">ℹ️ ${escapeHtml(h.legacy_note)}</div>` : ''}
          </div>
        </div>
      `;
    });

    ogsmHistoryModalList.innerHTML = cardsHtml;
  }
  if (btnCloseHistoryModal) btnCloseHistoryModal.addEventListener("click", () => ogsmHistoryModal.classList.add("hidden"));
  if (btnOkHistoryModal) btnOkHistoryModal.addEventListener("click", () => ogsmHistoryModal.classList.add("hidden"));

  // 刪除日報處理函式 (樂觀刪除 Optimistic Delete：0 秒移除卡片，背景非同步同步)
  function deleteOgsmReport(rowIndex, isOffline, offlineId, dateStr) {
    if (isOffline) {
      showConfirmModal("確定要刪除此筆尚未同步的離線日報嗎？", () => {
        removeOfflineOgsmDraft(offlineId);
        refreshCurrentDayModal();
        renderCalendar(ogsmCurrentYear, ogsmCurrentMonth);
        showToast("🗑️ 離線日報已刪除", "info");
      });
      return;
    }

    showConfirmModal("確定要刪除這筆業務日報嗎？", () => {
      const salesName = getSalesName();
      const rIdx = parseInt(rowIndex, 10);

      // 1. 備份該筆資料物件 (以備異常復原)
      const targetIdx = ogsmMonthReports.findIndex(r => r.row_index === rIdx && r.date === dateStr);
      if (targetIdx === -1) return;
      const backupItem = ogsmMonthReports[targetIdx];

      // 2. 0 秒立即自記憶體移除 (樂觀刪除)
      ogsmMonthReports.splice(targetIdx, 1);

      // 3. 立即重新繪製列表與月曆 (完全不跳全螢幕轉圈遮罩！)
      refreshCurrentDayModal();
      renderCalendar(ogsmCurrentYear, ogsmCurrentMonth);
      showToast(`🗑️ 已刪除「${backupItem.client_name}」，背景同步中...`, "info");

      // 4. 背景非同步發送雲端刪除請求
      (async () => {
        try {
          const params = new URLSearchParams({
            action: "delete_ogsm",
            user_name: salesName,
            row_index: rowIndex,
            is_test: isTestMode ? "1" : "0"
          });

          const res = await fetch(`${GAS_URL}?${params.toString()}`);
          const data = await res.json();
          if (data.status !== "ok") throw new Error(data.msg || "伺服器刪除失敗");

          // 成功後靜默載入最新整月紀錄以重排項次
          await loadOgsmMonthly(ogsmCurrentYear, ogsmCurrentMonth);
          invalidateMonthlyReportCaches();
          showToast(`✅「${backupItem.client_name}」已成功自雲端移除`, "success");
        } catch (err) {
          console.warn("[OGSM] 背景刪除失敗，復原該筆資料:", err);
          // 失敗：復原該筆資料
          ogsmMonthReports.splice(targetIdx, 0, backupItem);
          refreshCurrentDayModal();
          renderCalendar(ogsmCurrentYear, ogsmCurrentMonth);
          showToast(`⚠️ 刪除「${backupItem.client_name}」失敗，已自動復原`, "error");
        }
      })();
    });
  }

  // ====================================================
  // 離線佇列與背景自動補傳 (Offline Fault Tolerance)
  // ====================================================
  function getOfflineOgsmDrafts() {
    try {
      return JSON.parse(localStorage.getItem("offline_ogsm_drafts") || "[]");
    } catch (e) {
      return [];
    }
  }

  function saveToOfflineOgsmDrafts(item) {
    const drafts = getOfflineOgsmDrafts();
    item.offline_id = "off_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);
    item.created_at = new Date().toLocaleString();
    drafts.push(item);
    localStorage.setItem("offline_ogsm_drafts", JSON.stringify(drafts));
  }

  function updateOfflineOgsmDraft(offlineId, updatedPayload) {
    const drafts = getOfflineOgsmDrafts();
    const idx = drafts.findIndex(d => d.offline_id === offlineId);
    if (idx !== -1) {
      drafts[idx] = Object.assign(drafts[idx], updatedPayload, { updated_at: new Date().toLocaleString() });
      localStorage.setItem("offline_ogsm_drafts", JSON.stringify(drafts));
    } else {
      saveToOfflineOgsmDrafts(updatedPayload);
    }
  }

  function cleanDuplicateOfflineDrafts(dateStr, clientName) {
    let drafts = getOfflineOgsmDrafts();
    drafts = drafts.filter(d => !(d.date === dateStr && d.client_name === clientName));
    localStorage.setItem("offline_ogsm_drafts", JSON.stringify(drafts));
  }

  function removeOfflineOgsmDraft(offlineId) {
    let drafts = getOfflineOgsmDrafts();
    drafts = drafts.filter(d => d.offline_id !== offlineId);
    localStorage.setItem("offline_ogsm_drafts", JSON.stringify(drafts));
  }

  async function resendSingleOfflineOgsmDraft(offlineId, dateStr) {
    const drafts = getOfflineOgsmDrafts();
    const draft = drafts.find(d => d.offline_id === offlineId);
    if (!draft) return;

    loadingOverlay.classList.remove("hidden");
    const loadingText = document.getElementById("loadingOverlayText");
    if (loadingText) loadingText.textContent = "離線日報上傳中...";

    try {
      const params = new URLSearchParams({
        action: "save_ogsm",
        user_name: draft.user_name,
        date: draft.date,
        client_name: draft.client_name,
        client_type: draft.client_type,
        content: draft.content,
        result: draft.result,
        is_test: draft.is_test
      });
      if (draft.row_index) params.append("row_index", draft.row_index);

      const res = await fetch(`${GAS_URL}?${params.toString()}`);
      const data = await res.json();
      if (data.status !== "ok") throw new Error(data.msg || "上傳失敗");

      removeOfflineOgsmDraft(offlineId);
      await loadOgsmMonthly(ogsmCurrentYear, ogsmCurrentMonth);

      const onlineList = ogsmMonthReports.filter(r => r.date === dateStr);
      const offlineList = getOfflineOgsmDrafts().filter(r => r.date === dateStr);
      const allReports = [...offlineList, ...onlineList];
      if (allReports.length > 0) {
        openOgsmDayViewModal(dateStr, allReports);
      } else {
        closeOgsmDayViewModal();
      }

      alert("✅ 離線日報已成功同步至雲端試算表！");
    } catch (err) {
      alert("補傳失敗：" + err.message);
    } finally {
      loadingOverlay.classList.add("hidden");
      if (loadingText) loadingText.textContent = "處理中...";
    }
  }

  async function syncOfflineOgsmDrafts() {
    if (isOgsmSyncing) return; // 互斥鎖：嚴禁多程序重疊執行
    const drafts = getOfflineOgsmDrafts();
    if (drafts.length === 0) return;

    isOgsmSyncing = true;
    console.log(`[OGSM] 偵測到連線，啟動背景補傳 (${drafts.length} 筆離線日報)...`);

    try {
      for (let i = 0; i < drafts.length; i++) {
        const d = drafts[i];
        try {
          const params = new URLSearchParams({
            action: "save_ogsm",
            user_name: d.user_name,
            date: d.date,
            client_name: d.client_name,
            client_type: d.client_type,
            content: d.content,
            result: d.result,
            is_test: d.is_test
          });
          if (d.row_index) params.append("row_index", d.row_index);

          const res = await fetch(`${GAS_URL}?${params.toString()}`);
          const data = await res.json();
          if (data.status === "ok") {
            // 成功一筆即刻刪除本機草稿，杜絕重複寫入
            removeOfflineOgsmDraft(d.offline_id);
            console.log(`[OGSM] 離線日報「${d.client_name}」補傳成功並已自本機移除`);
          }
        } catch (singleErr) {
          console.warn(`[OGSM] 離線日報「${d.client_name}」補傳暫時失敗:`, singleErr);
        }
      }

      if (currentAppMode === "ogsm") {
        await loadOgsmMonthly(ogsmCurrentYear, ogsmCurrentMonth);
        if (currentViewingDate) {
          refreshCurrentDayModal();
        }
      }
    } finally {
      isOgsmSyncing = false;
    }
  }

  // ====================================================
  // 全域關鍵字即時搜尋 (搜尋時隱藏選定日面板，點擊直接開案)
  // ====================================================
  let searchDebounceTimer = null;
  if (ogsmSearchInput && ogsmSearchResultsPanel) {
    ogsmSearchInput.addEventListener("input", () => {
      const keyword = (ogsmSearchInput.value || "").trim().toLowerCase();
      if (btnOgsmSearchClear) {
        if (keyword) btnOgsmSearchClear.classList.remove("hidden");
        else btnOgsmSearchClear.classList.add("hidden");
      }

      if (!keyword) {
        ogsmSearchResultsPanel.innerHTML = "";
        ogsmSearchResultsPanel.classList.add("hidden");
        if (ogsmDayPanel) ogsmDayPanel.classList.remove("hidden"); // 恢復顯示選取日期的日報清單
        return;
      }

      // 搜尋中：隱藏選取日期的日報面板，專注呈現搜尋結果
      if (ogsmDayPanel) {
        ogsmDayPanel.classList.add("hidden");
      }

      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(async () => {
        // 1. 本地快速搜尋 (已載入當月紀錄 + 離線暫存)
        const offlineList = getOfflineOgsmDrafts();
        const localPool = [...ogsmMonthReports, ...offlineList];
        const localMatches = localPool.filter(r => {
          const text = `${r.date} ${r.client_name} ${r.client_type} ${r.content} ${r.result}`.toLowerCase();
          return text.includes(keyword);
        });

        renderSearchResults(localMatches, keyword);

        // 2. 背景請求全年度歷史搜尋
        try {
          const salesName = getSalesName();
          const params = new URLSearchParams({
            action: "search_ogsm",
            user_name: salesName,
            keyword: keyword,
            is_test: isTestMode ? "1" : "0"
          });
          const res = await fetch(`${GAS_URL}?${params.toString()}`);
          const data = await res.json();
          if (data.status === "ok" && Array.isArray(data.records) && data.records.length > 0) {
            const map = new Map();
            localMatches.forEach(item => map.set(item.row_index || item.temp_id || (item.date + item.client_name), item));
            data.records.forEach(item => {
              const key = item.row_index || (item.date + item.client_name);
              map.set(key, item);
            });
            renderSearchResults(Array.from(map.values()), keyword);
          }
        } catch(e) {
          console.warn("[OGSM] 雲端全文搜尋失敗:", e);
        }
      }, 250);
    });

    if (btnOgsmSearchClear) {
      btnOgsmSearchClear.addEventListener("click", () => {
        ogsmSearchInput.value = "";
        btnOgsmSearchClear.classList.add("hidden");
        ogsmSearchResultsPanel.innerHTML = "";
        ogsmSearchResultsPanel.classList.add("hidden");
        if (ogsmDayPanel) ogsmDayPanel.classList.remove("hidden"); // 清除搜尋後恢復選取日期的日報清單
      });
    }
  }

  function renderSearchResults(records, keyword) {
    if (!ogsmSearchResultsPanel) return;
    if (ogsmDayPanel) ogsmDayPanel.classList.add("hidden"); // 確保選定日面板維持隱藏

    if (!records || records.length === 0) {
      ogsmSearchResultsPanel.innerHTML = `
        <div class="ogsm-search-results-header">
          <span>🔍 搜尋結果</span>
        </div>
        <div style="padding:15px; text-align:center; color:#94a3b8; font-size:0.85rem;">查無「${escapeHtml(keyword)}」相關日報紀錄</div>
      `;
      ogsmSearchResultsPanel.classList.remove("hidden");
      return;
    }

    let html = `
      <div class="ogsm-search-results-header">
        <span>🔍 搜尋結果（共 ${records.length} 筆）</span>
        <span style="font-size:0.75rem; color:#64748b;">點擊直接開啟案件詳情</span>
      </div>
    `;

    const displayRecords = records.slice(0, 50);
    displayRecords.forEach((item, idx) => {
      html += `
        <div class="ogsm-search-item" data-sidx="${idx}">
          <div class="ogsm-search-item-header">
            <span class="ogsm-search-item-client">${escapeHtml(item.client_name)}</span>
            <div>
              <span class="badge-client-type" style="font-size:0.72rem; padding:2px 6px;">${escapeHtml(item.client_type || '其它')}</span>
              <span class="ogsm-search-item-date" style="margin-left:6px;">📅 ${escapeHtml(item.date)}</span>
            </div>
          </div>
          <div class="ogsm-search-item-body">
            <b>工作內容：</b>${escapeHtml(item.content || '無')} | <b>實際行程：</b>${escapeHtml(item.result || '無')}
          </div>
          <div style="font-size:0.75rem; color:#94a3b8; margin-top:3px;">
            更新：${formatTwDateTime(item.updated_at || item.created_at)}
          </div>
        </div>
      `;
    });

    ogsmSearchResultsPanel.innerHTML = html;
    ogsmSearchResultsPanel.classList.remove("hidden");

    // 平滑滾動讓搜尋結果進入視野
    try {
      ogsmSearchResultsPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch(e) {}

    // 點擊搜尋項目：直接開啟日報編輯/檢視視窗，無需先跳轉至該日
    ogsmSearchResultsPanel.querySelectorAll(".ogsm-search-item").forEach(el => {
      el.addEventListener("click", () => {
        const sidx = parseInt(el.dataset.sidx, 10);
        const targetItem = displayRecords[sidx];
        if (targetItem) {
          openOgsmEditModal(targetItem.date, targetItem);
        }
      });
    });
  }

  // ====================================================
  // LINE 業務匯報一鍵生成並複製 (主管標準格式)
  // ====================================================
  if (btnCopyLineReport) {
    btnCopyLineReport.addEventListener("click", async () => {
      if (!currentViewingDate) {
        showToast("⚠️ 請先選擇欲匯報之日期", "warning");
        return;
      }

      const salesName = getSalesName();

      // 計算次日日期 (明日)
      const curDateObj = new Date(currentViewingDate.replace(/-/g, "/"));
      const nextDateObj = new Date(curDateObj.getTime() + 86400000);
      const nextYear = nextDateObj.getFullYear();
      const nextMonth = String(nextDateObj.getMonth() + 1).padStart(2, '0');
      const nextDay = String(nextDateObj.getDate()).padStart(2, '0');
      const nextDateStr = `${nextYear}-${nextMonth}-${nextDay}`;

      // 取得今日實際行程紀錄
      const todayOnline = ogsmMonthReports.filter(r => r.date === currentViewingDate);
      const todayOffline = getOfflineOgsmDrafts().filter(r => r.date === currentViewingDate);
      const todayAll = [...todayOffline, ...todayOnline];

      // 取得明日預計行程紀錄
      const nextOnline = ogsmMonthReports.filter(r => r.date === nextDateStr);
      const nextOffline = getOfflineOgsmDrafts().filter(r => r.date === nextDateStr);
      const nextAll = [...nextOffline, ...nextOnline];

      let output = `【${salesName} 業務匯報】\n\n`;

      // 今日實際行程區塊
      output += `${currentViewingDate} (今日實際行程)\n--------------\n`;
      if (todayAll.length === 0) {
        output += `本日尚無拜訪行程紀錄\n--------------\n`;
      } else {
        todayAll.forEach(item => {
          output += `客戶：${item.client_name} ，客戶分類：${item.client_type || '(O) 其它'}\n`;
          output += `計畫：${item.content || '無'}\n`;
          output += `實際：${item.result || '無'}\n--------------\n`;
        });
      }

      output += `\n`;

      // 明日預計行程區塊
      output += `${nextDateStr} (明日預計行程)\n--------------\n`;
      if (nextAll.length === 0) {
        output += `尚未排定明日預計拜訪行程\n--------------\n`;
      } else {
        nextAll.forEach(item => {
          output += `客戶：${item.client_name} ，客戶分類：${item.client_type || '(O) 其它'}\n`;
          output += `計畫：${item.content || '無'}\n`;
          output += `實際：${item.result || 'None'}\n--------------\n`;
        });
      }

      try {
        await navigator.clipboard.writeText(output.trim());
        showToast("📋 LINE 業務匯報格式已複製！可直接貼至 LINE", "success");
      } catch (clipErr) {
        // 剪貼簿 API 失敗備用方案
        const ta = document.createElement("textarea");
        ta.value = output.trim();
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showToast("📋 LINE 業務匯報格式已複製！可直接貼至 LINE", "success");
      }
    });
  }

  // ====================================================
  // 模組八：客戶跟催紅綠燈清單與三大主管轉派覆核引擎
  // ====================================================

  let activeFollowUpList = [];
  let currentFollowUpFilter = "all";
  let activeNoContactTarget = null;
  let activeReassignTarget = null;
  let activePendingReviews = [];

  // 工具列「🚨 客戶跟催」按鈕開啟對話框
  if (btnOpenFollowUpModal) {
    btnOpenFollowUpModal.addEventListener("click", () => {
      if (followUpModal) followUpModal.classList.remove("hidden");
      renderFollowUpList();
    });
  }
  if (btnCloseFollowUpModal) btnCloseFollowUpModal.addEventListener("click", () => {
    if (followUpModal) followUpModal.classList.add("hidden");
  });
  if (btnCloseFollowUpFooter) btnCloseFollowUpFooter.addEventListener("click", () => {
    if (followUpModal) followUpModal.classList.add("hidden");
  });

  // 工具列「🔄 轉派覆核」按鈕開啟主管專區對話框
  if (btnOpenReviewModal) {
    btnOpenReviewModal.addEventListener("click", () => {
      if (managerReviewModal) managerReviewModal.classList.remove("hidden");
      loadPendingReviews();
    });
  }
  if (btnCloseManagerReviewModal) btnCloseManagerReviewModal.addEventListener("click", () => {
    if (managerReviewModal) managerReviewModal.classList.add("hidden");
  });
  if (btnCloseManagerReviewFooter) btnCloseManagerReviewFooter.addEventListener("click", () => {
    if (managerReviewModal) managerReviewModal.classList.add("hidden");
  });
  if (btnRefreshManagerReview) btnRefreshManagerReview.addEventListener("click", () => {
    loadPendingReviews();
  });

  // 跟催清單即時關鍵字搜尋
  if (followUpSearchInput) {
    followUpSearchInput.addEventListener("input", () => {
      renderFollowUpList();
    });
  }

  // 篩選標籤點擊切換
  function setFollowUpFilter(filter) {
    currentFollowUpFilter = filter;
    if (btnFilterFollowUpAll) btnFilterFollowUpAll.classList.toggle("active", filter === "all");
    if (btnFilterFollowUpRed) btnFilterFollowUpRed.classList.toggle("active", filter === "red");
    if (btnFilterFollowUpYellow) btnFilterFollowUpYellow.classList.toggle("active", filter === "yellow");
    renderFollowUpList();
  }

  if (btnFilterFollowUpAll) btnFilterFollowUpAll.addEventListener("click", () => setFollowUpFilter("all"));
  if (btnFilterFollowUpRed) btnFilterFollowUpRed.addEventListener("click", () => setFollowUpFilter("red"));
  if (btnFilterFollowUpYellow) btnFilterFollowUpYellow.addEventListener("click", () => setFollowUpFilter("yellow"));

  // ⚙️ 跟催天數設定對話框事件
  if (btnOpenFollowUpSettings) {
    btnOpenFollowUpSettings.addEventListener("click", () => {
      const s = getFollowUpSettings();
      if (settingDaysA) settingDaysA.value = s.days_a;
      if (settingDaysB) settingDaysB.value = s.days_b;
      if (settingDaysC) settingDaysC.value = s.days_c;
      if (settingDaysDistributor) settingDaysDistributor.value = s.days_distributor;
      if (followUpSettingsModal) followUpSettingsModal.classList.remove("hidden");
    });
  }
  if (btnCloseFollowUpSettings) btnCloseFollowUpSettings.addEventListener("click", () => {
    if (followUpSettingsModal) followUpSettingsModal.classList.add("hidden");
  });
  if (btnCancelFollowUpSettings) btnCancelFollowUpSettings.addEventListener("click", () => {
    if (followUpSettingsModal) followUpSettingsModal.classList.add("hidden");
  });
  if (btnResetFollowUpSettings) {
    btnResetFollowUpSettings.addEventListener("click", () => {
      if (settingDaysA) settingDaysA.value = DEFAULT_FOLLOW_UP_SETTINGS.days_a;
      if (settingDaysB) settingDaysB.value = DEFAULT_FOLLOW_UP_SETTINGS.days_b;
      if (settingDaysC) settingDaysC.value = DEFAULT_FOLLOW_UP_SETTINGS.days_c;
      if (settingDaysDistributor) settingDaysDistributor.value = DEFAULT_FOLLOW_UP_SETTINGS.days_distributor;
    });
  }
  if (btnSaveFollowUpSettings) {
    btnSaveFollowUpSettings.addEventListener("click", () => {
      const s = {
        days_a: parseInt(settingDaysA?.value, 10) || 14,
        days_b: parseInt(settingDaysB?.value, 10) || 30,
        days_c: parseInt(settingDaysC?.value, 10) || 30,
        days_distributor: parseInt(settingDaysDistributor?.value, 10) || 14
      };
      saveFollowUpSettings(s);
      showToast("✅ 已成功儲存跟催天數門檻設定", "success");
      if (followUpSettingsModal) followUpSettingsModal.classList.add("hidden");
      refreshFollowUpEngine();
    });
  }

  // 🚫 提報不聯繫對話框取消事件
  if (btnCloseNoContactModal) btnCloseNoContactModal.addEventListener("click", () => {
    if (noContactModal) noContactModal.classList.add("hidden");
  });
  if (btnCancelNoContact) btnCancelNoContact.addEventListener("click", () => {
    if (noContactModal) noContactModal.classList.add("hidden");
  });

  // 轉派子對話框取消事件
  if (btnCloseReassignSubModal) btnCloseReassignSubModal.addEventListener("click", () => {
    if (reassignSubModal) reassignSubModal.classList.add("hidden");
  });
  if (btnCancelReassignSub) btnCancelReassignSub.addEventListener("click", () => {
    if (reassignSubModal) reassignSubModal.classList.add("hidden");
  });


  // 重新整理並載入跟催資料引擎
  async function refreshFollowUpEngine() {
    const currentSales = getSalesName();
    if (!currentSales) return;

    if (isCurrentUserManager()) {
      if (btnOpenReviewModal) btnOpenReviewModal.classList.remove("hidden");
      loadPendingReviews();
    } else {
      if (btnOpenReviewModal) btnOpenReviewModal.classList.add("hidden");
    }

    const today = new Date();
    const curYear = today.getFullYear();
    const startDate = `${curYear - 1}-01-01`;
    const endDate = `${curYear}-12-31`;

    try {
      const params = new URLSearchParams({
        action: "export_monthly_report",
        start_date: startDate,
        end_date: endDate,
        sales_name: isCurrentUserManager() ? "" : currentSales,
        viewer: currentSales
      });

      const res = await fetch(`${GAS_URL}?${params.toString()}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.status === "ok" && Array.isArray(data.records)) {
        computeFollowUpData(data.records);
      }
    } catch(err) {
      console.warn("更新跟催資料異常:", err);
    }
  }

  // 核心跟催演算法：聚合同一客戶最新拜訪日/轉派日，計算未聯繫天數與警示燈號
  function computeFollowUpData(records) {
    const currentSales = getSalesName();
    const settings = getFollowUpSettings();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let userRecords = records;
    if (!isCurrentUserManager()) {
      userRecords = records.filter(r => r.client_owner === currentSales || r.user_name === currentSales || r.sales_name === currentSales);
    }

    const clientMap = new Map();

    userRecords.forEach(r => {
      const cName = (r.client_name || "").trim();
      if (!cName) return;

      const fStatus = (r.follow_up_status || "正常跟催").trim();
      if (fStatus === "已結案封存" || fStatus === "待主管覆核") return;

      let visitTime = 0;
      let visitDateStr = r.visit_date || "";
      if (visitDateStr) {
        const vm = String(visitDateStr).match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
        if (vm) {
          visitTime = new Date(parseInt(vm[1], 10), parseInt(vm[2], 10) - 1, parseInt(vm[3], 10)).getTime();
        }
      }

      let reassignTime = 0;
      let reassignDateStr = "";
      if (r.reassigned_info) {
        const rm = String(r.reassigned_info).match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
        if (rm) {
          reassignDateStr = `${rm[1]}/${rm[2]}/${rm[3]}`;
          reassignTime = new Date(parseInt(rm[1], 10), parseInt(rm[2], 10) - 1, parseInt(rm[3], 10)).getTime();
        }
      }

      const effectiveTime = Math.max(visitTime, reassignTime);

      if (!clientMap.has(cName)) {
        clientMap.set(cName, {
          client_name: cName,
          client_owner: r.client_owner || r.user_name || currentSales,
          client_nature: r.client_nature || "",
          effective_time: effectiveTime,
          visit_date: visitDateStr,
          reassign_date: reassignDateStr,
          latest_case_name: r.case_name || "",
          estimated_amount: r.estimated_amount || 0,
          row_index: r.row_index
        });
      } else {
        const existing = clientMap.get(cName);
        if (effectiveTime > existing.effective_time) {
          existing.effective_time = effectiveTime;
          existing.visit_date = visitDateStr;
          existing.reassign_date = reassignDateStr;
          existing.latest_case_name = r.case_name || existing.latest_case_name;
          existing.estimated_amount = r.estimated_amount || existing.estimated_amount;
          existing.client_nature = r.client_nature || existing.client_nature;
          existing.row_index = r.row_index;
        }
      }
    });

    const resultList = [];
    clientMap.forEach(c => {
      const cName = c.client_name;
      let diffDays = 0;
      if (c.effective_time > 0) {
        diffDays = Math.max(0, Math.floor((today.getTime() - c.effective_time) / 86400000));
      } else {
        diffDays = 999;
      }
      c.diff_days = diffDays;

      const nature = c.client_nature;
      let tierType = "A 級";
      let threshold = settings.days_a;

      const isSpecialDealer = REMINDER_DEALERS.some(d => cName.indexOf(d) !== -1);
      const isOtherDealer = !isSpecialDealer && (nature.indexOf("經銷") !== -1 || cName.indexOf("經銷") !== -1 || ["良鴻", "松金", "紅偉"].some(d => cName.indexOf(d) !== -1));

      if (isOtherDealer) {
        return;
      }

      if (isSpecialDealer) {
        tierType = "經銷商";
        threshold = settings.days_distributor;
        if (diffDays > threshold) {
          c.alert_level = "red";
          c.alert_label = "久未聯繫";
        } else {
          c.alert_level = "green";
          c.alert_label = "正常跟催中";
        }
      } else if (nature.indexOf("A") !== -1 || nature.indexOf("既有") !== -1) {
        tierType = nature.indexOf("D-A") !== -1 ? "D-A 級" : "A 級";
        threshold = settings.days_a;
        if (diffDays > threshold) {
          c.alert_level = "red";
          c.alert_label = "久未聯繫";
        } else {
          c.alert_level = "green";
          c.alert_label = "正常跟催中";
        }
      } else if (nature.indexOf("B") !== -1) {
        tierType = nature.indexOf("D-B") !== -1 ? "D-B 級" : "B 級";
        threshold = settings.days_b;
        if (diffDays > threshold) {
          c.alert_level = "yellow";
          c.alert_label = "提醒關注";
        } else {
          c.alert_level = "green";
          c.alert_label = "正常跟催中";
        }
      } else {
        tierType = nature.indexOf("D-C") !== -1 ? "D-C 級" : "C 級";
        threshold = settings.days_c;
        if (diffDays > threshold) {
          c.alert_level = "yellow";
          c.alert_label = "提醒關注";
        } else {
          c.alert_level = "green";
          c.alert_label = "正常跟催中";
        }
      }

      c.tier_display = tierType;
      c.threshold = threshold;
      resultList.push(c);
    });

    resultList.sort((a, b) => {
      const score = { "red": 3, "yellow": 2, "green": 1 };
      if (score[b.alert_level] !== score[a.alert_level]) {
        return score[b.alert_level] - score[a.alert_level];
      }
      return b.diff_days - a.diff_days;
    });

    activeFollowUpList = resultList;

    const urgentCount = resultList.filter(item => item.alert_level === "red" || item.alert_level === "yellow").length;
    if (followUpBadge) {
      followUpBadge.textContent = urgentCount;
      if (urgentCount > 0) {
        followUpBadge.classList.remove("hidden");
      } else {
        followUpBadge.classList.add("hidden");
      }
    }
    if (followUpCount) followUpCount.textContent = urgentCount;

    const redCount = resultList.filter(item => item.alert_level === "red").length;
    const yellowCount = resultList.filter(item => item.alert_level === "yellow").length;
    if (filterAllCount) filterAllCount.textContent = resultList.length;
    if (filterRedCount) filterRedCount.textContent = redCount;
    if (filterYellowCount) filterYellowCount.textContent = yellowCount;

    renderFollowUpList();
  }

  function renderFollowUpList() {
    if (!followUpListContainer) return;
    const keyword = (followUpSearchInput ? followUpSearchInput.value : "").trim().toLowerCase();

    let filtered = activeFollowUpList;
    if (currentFollowUpFilter === "red") {
      filtered = filtered.filter(i => i.alert_level === "red");
    } else if (currentFollowUpFilter === "yellow") {
      filtered = filtered.filter(i => i.alert_level === "yellow");
    }

    if (keyword) {
      filtered = filtered.filter(i =>
        i.client_name.toLowerCase().indexOf(keyword) !== -1 ||
        (i.tier_display && i.tier_display.toLowerCase().indexOf(keyword) !== -1) ||
        (i.latest_case_name && i.latest_case_name.toLowerCase().indexOf(keyword) !== -1)
      );
    }

    if (filtered.length === 0) {
      followUpListContainer.innerHTML = '<div style="text-align:center; padding:30px; color:#64748b; font-size:0.88rem;">🎉 目前無任何符合條件的跟催提醒客戶</div>';
      return;
    }

    followUpListContainer.innerHTML = filtered.map(c => {
      const borderClass = c.alert_level === "red" ? "card-border-red" : (c.alert_level === "yellow" ? "card-border-yellow" : "card-border-green");
      const badgeClass = c.alert_level === "red" ? "badge-status-red" : (c.alert_level === "yellow" ? "badge-status-yellow" : "badge-status-green");
      const daysText = c.diff_days >= 999 ? "無更新紀錄" : `${c.diff_days} 天前更新`;
      const dateInfo = c.reassign_date ? `📅 轉派日: ${c.reassign_date} (緩衝期)` : (c.visit_date ? `📅 最後拜訪: ${c.visit_date}` : "尚未拜訪");

      return `
        <div class="follow-up-card ${borderClass}">
          <div class="follow-up-card-header">
            <div class="follow-up-client-title">
              <span class="follow-up-client-name">${escapeHtml(c.client_name)}</span>
              <span class="badge-tier">${escapeHtml(c.tier_display)}</span>
              <span class="${badgeClass}">${escapeHtml(c.alert_label)}</span>
            </div>
            <span class="follow-up-days-text ${c.alert_level === 'red' ? 'text-red' : 'text-yellow'}">
              ${daysText}
            </span>
          </div>

          <div class="follow-up-card-body">
            <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:4px;">
              <span>👤 負責業務：${c.client_owner}</span>
              <span>${dateInfo}</span>
            </div>
            ${c.latest_case_name ? `<div>💼 最新案件：${c.latest_case_name} ${c.estimated_amount > 0 ? `(${c.estimated_amount}萬)` : ''}</div>` : ''}
          </div>

          <div class="follow-up-card-actions">
            <button type="button" class="btn-card-action btn-card-action-nocontact" data-client="${c.client_name}" data-owner="${c.client_owner}" data-tier="${c.tier_display}" data-row="${c.row_index || ''}">
              🚫 標記不聯繫
            </button>
            <button type="button" class="btn-card-action btn-card-action-visit" data-client="${c.client_name}">
              📅 立即排訪
            </button>
          </div>
        </div>
      `;
    }).join("");

    followUpListContainer.querySelectorAll(".btn-card-action-visit").forEach(btn => {
      btn.addEventListener("click", () => {
        const client = btn.getAttribute("data-client");
        if (followUpModal) followUpModal.classList.add("hidden");
        if (btnAddDayReport) btnAddDayReport.click();
        setTimeout(() => {
          const clientInput = document.getElementById("ogsmCustomerSelect") || document.getElementById("customerName");
          if (clientInput) {
            clientInput.value = client;
            clientInput.dispatchEvent(new Event("change"));
          }
        }, 300);
      });
    });

    followUpListContainer.querySelectorAll(".btn-card-action-nocontact").forEach(btn => {
      btn.addEventListener("click", () => {
        const client = btn.getAttribute("data-client");
        const owner = btn.getAttribute("data-owner");
        const tier = btn.getAttribute("data-tier");
        const rowIndex = btn.getAttribute("data-row");
        openNoContactModal({ client_name: client, client_owner: owner, tier: tier, row_index: rowIndex });
      });
    });
  }

  function openNoContactModal(data) {
    activeNoContactTarget = data;
    if (noContactClientTitle) noContactClientTitle.textContent = data.client_name;
    if (noContactClientMeta) noContactClientMeta.textContent = `負責業務：${data.client_owner} | 分級：${data.tier}`;
    if (noContactReasonDesc) noContactReasonDesc.value = "";
    if (noContactReasonType) noContactReasonType.selectedIndex = 0;
    if (noContactModal) noContactModal.classList.remove("hidden");
  }

  if (btnConfirmSubmitNoContact) {
    btnConfirmSubmitNoContact.addEventListener("click", async () => {
      if (!activeNoContactTarget) return;
      const clientName = activeNoContactTarget.client_name;
      const rowIndex = activeNoContactTarget.row_index || "";
      const reasonType = noContactReasonType ? noContactReasonType.value : "價格無競爭優勢";
      const reasonDesc = noContactReasonDesc ? noContactReasonDesc.value.trim() : "";

      btnConfirmSubmitNoContact.disabled = true;
      btnConfirmSubmitNoContact.textContent = "⏳ 呈報中...";

      try {
        const params = new URLSearchParams({
          action: "submit_client_no_contact",
          client_name: clientName,
          row_index: rowIndex,
          user_name: getSalesName(),
          reason_type: reasonType,
          reason_desc: reasonDesc
        });

        const res = await fetch(`${GAS_URL}?${params.toString()}`);
        const data = await res.json();

        if (data.status === "ok") {
          showToast(`✅ 客戶「${clientName}」已呈報至三大主管進行轉派覆核`, "success");
          if (noContactModal) noContactModal.classList.add("hidden");
          activeFollowUpList = activeFollowUpList.filter(item => item.client_name !== clientName);
          renderFollowUpList();
          const urgentCount = activeFollowUpList.filter(item => item.alert_level === "red" || item.alert_level === "yellow").length;
          if (followUpBadge) followUpBadge.textContent = urgentCount;
          if (followUpCount) followUpCount.textContent = urgentCount;
          if (isCurrentUserManager()) loadPendingReviews();
        } else {
          alert("提報失敗：" + (data.msg || "未知錯誤"));
        }
      } catch(err) {
        console.error("提報不聯繫網路異常:", err);
        alert("提報失敗，請檢查網路連線。");
      } finally {
        btnConfirmSubmitNoContact.disabled = false;
        btnConfirmSubmitNoContact.textContent = "📤 確認呈報主管";
      }
    });
  }

  // ====================================================
  // 三大主管「🔄 轉派覆核」專區載入與三軌處置
  // ====================================================

  async function loadPendingReviews() {
    const currentSales = getSalesName();
    if (!isCurrentUserManager()) return;

    try {
      const params = new URLSearchParams({
        action: "get_pending_reviews",
        viewer: currentSales
      });
      const res = await fetch(`${GAS_URL}?${params.toString()}`);
      const data = await res.json();

      if (data.status === "ok" && Array.isArray(data.records)) {
        activePendingReviews = data.records;
        const count = activePendingReviews.length;
        if (reviewBadge) {
          reviewBadge.textContent = count;
          if (count > 0) {
            reviewBadge.classList.remove("hidden");
          } else {
            reviewBadge.classList.add("hidden");
          }
        }
        if (managerReviewCount) managerReviewCount.textContent = count;
        renderManagerReviewList();
      }
    } catch(err) {
      console.warn("載入待覆核名單異常:", err);
    }
  }

  function renderManagerReviewList() {
    if (!managerReviewListContainer) return;

    if (activePendingReviews.length === 0) {
      managerReviewListContainer.innerHTML = '<div style="text-align:center; padding:30px; color:#64748b; font-size:0.88rem;">🎉 目前無任何組員提報的待覆核客戶</div>';
      return;
    }

    managerReviewListContainer.innerHTML = activePendingReviews.map(item => {
      return `
        <div class="manager-review-card">
          <div class="manager-review-card-header">
            <div class="manager-review-title">
              <span>🏢 ${item.client_name}</span>
              <span class="badge-tier">${item.client_nature || '未分級'}</span>
              <span class="badge-status-red">待主管覆核</span>
            </div>
            <span style="font-size:0.78rem; color:#64748b;">${item.latest_update || ''}</span>
          </div>

          <div class="manager-review-meta">
            <span>👤 原提報業務：<b>${item.client_owner || item.sales_name}</b></span>
            <span>📅 最後拜訪：${item.visit_date || '無紀錄'}</span>
            ${item.case_name ? `<span>💼 案件：${item.case_name}</span>` : ''}
            ${item.estimated_amount > 0 ? `<span>💰 金額：${item.estimated_amount}萬</span>` : ''}
          </div>

          <div class="manager-review-reason-box">
            <b>📝 提報不聯繫原因：</b><br>
            ${item.no_contact_reason || '未提供具體原因說明'}
          </div>

          <div class="manager-review-actions">
            <button type="button" class="btn-mgr-reassign" data-client="${item.client_name}" data-row="${item.row_index}" data-owner="${item.client_owner}">
              🔄 指派新業務接手
            </button>
            <button type="button" class="btn-mgr-archive" data-client="${item.client_name}" data-row="${item.row_index}">
              📁 同意結案封存
            </button>
            <button type="button" class="btn-mgr-reject" data-client="${item.client_name}" data-row="${item.row_index}" data-owner="${item.client_owner}">
              ↩️ 退回原業務
            </button>
          </div>
        </div>
      `;
    }).join("");

    managerReviewListContainer.querySelectorAll(".btn-mgr-reassign").forEach(btn => {
      btn.addEventListener("click", () => {
        const client = btn.getAttribute("data-client");
        const rowIndex = btn.getAttribute("data-row");
        const oldOwner = btn.getAttribute("data-owner");
        openReassignSubModal({ client_name: client, row_index: rowIndex, old_owner: oldOwner });
      });
    });

    managerReviewListContainer.querySelectorAll(".btn-mgr-archive").forEach(btn => {
      btn.addEventListener("click", async () => {
        const client = btn.getAttribute("data-client");
        const rowIndex = btn.getAttribute("data-row");
        if (!confirm(`確定同意將客戶「${client}」結案封存？\n\n封存後此客戶將不再發送任何拜訪提醒。`)) return;

        await processReviewDecision({
          row_index: rowIndex,
          client_name: client,
          review_action: "archive",
          manager_note: ""
        });
      });
    });

    managerReviewListContainer.querySelectorAll(".btn-mgr-reject").forEach(btn => {
      btn.addEventListener("click", async () => {
        const client = btn.getAttribute("data-client");
        const rowIndex = btn.getAttribute("data-row");
        const oldOwner = btn.getAttribute("data-owner");
        const note = prompt(`請輸入退回原業務【${oldOwner}】的督導指示：`, "請再次聯絡客戶了解現況");
        if (note === null) return;

        await processReviewDecision({
          row_index: rowIndex,
          client_name: client,
          review_action: "reject",
          manager_note: note
        });
      });
    });
  }

  function openReassignSubModal(target) {
    activeReassignTarget = target;
    if (reassignTargetClientName) reassignTargetClientName.textContent = `客戶：${target.client_name} (原負責人: ${target.old_owner})`;
    if (reassignManagerNote) reassignManagerNote.value = "";

    const viewer = getSalesName();
    let assignableList = ALL_SALES_MEMBERS;
    if (viewer === "曾仁君") {
      assignableList = DIRECT_SALES_MEMBERS;
    } else if (viewer === "張何達") {
      assignableList = DEALER_SALES_MEMBERS;
    }

    if (reassignNewOwnerSelect) {
      reassignNewOwnerSelect.innerHTML = assignableList
        .filter(m => m !== target.old_owner)
        .map(m => `<option value="${m}">${m}</option>`).join("");
    }

    if (reassignSubModal) reassignSubModal.classList.remove("hidden");
  }

  async function processReviewDecision(payload) {
    const viewer = getSalesName();
    try {
      const params = new URLSearchParams({
        action: "process_client_review",
        viewer: viewer,
        row_index: payload.row_index,
        client_name: payload.client_name,
        review_action: payload.review_action,
        new_owner: payload.new_owner || "",
        manager_note: payload.manager_note || ""
      });

      const res = await fetch(`${GAS_URL}?${params.toString()}`);
      const data = await res.json();

      if (data.status === "ok") {
        showToast(data.msg || "✅ 覆核處理完成", "success");
        if (reassignSubModal) reassignSubModal.classList.add("hidden");
        loadPendingReviews();
        invalidateMonthlyReportCaches();
        refreshFollowUpEngine();
      } else {
        alert("覆核操作失敗：" + (data.msg || "未知錯誤"));
      }
    } catch(err) {
      console.error("覆核操作異常:", err);
      alert("覆核操作失敗，請檢查網路連線。");
    }
  }

  if (btnConfirmReassignSub) {
    btnConfirmReassignSub.addEventListener("click", async () => {
      if (!activeReassignTarget) return;
      const newOwner = reassignNewOwnerSelect ? reassignNewOwnerSelect.value : "";
      if (!newOwner) {
        alert("請選擇指派接手的新業務");
        return;
      }
      const note = reassignManagerNote ? reassignManagerNote.value.trim() : "";

      btnConfirmReassignSub.disabled = true;
      btnConfirmReassignSub.textContent = "⏳ 轉派中...";

      await processReviewDecision({
        row_index: activeReassignTarget.row_index,
        client_name: activeReassignTarget.client_name,
        review_action: "reassign",
        new_owner: newOwner,
        manager_note: note
      });

      btnConfirmReassignSub.disabled = false;
      btnConfirmReassignSub.textContent = "✅ 確認轉派";
    });
  }

}); // end DOMContentLoaded
