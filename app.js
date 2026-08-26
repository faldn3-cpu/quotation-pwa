// 配置 GAS Web App 的 URL
const GAS_URL = "https://script.google.com/macros/s/AKfycby0A3Rmjb7n0a1hHsKHPpwEcyXU9BOXmtkzV-6A54M85ipXkX3N2ioxiLjjvi7wGjoKHg/exec";

// 實際客戶與產品資料庫 (從雲端動態載入)
let MOCK_CUSTOMERS = [];
let MOCK_PRODUCTS = [];

document.addEventListener("DOMContentLoaded", () => {
  // DOM 元素
  const loginSection = document.getElementById("loginSection");
  const draftSection = document.getElementById("draftSection");
  const successSection = document.getElementById("successSection");
  const loadingOverlay = document.getElementById("loadingOverlay");
  const offlineIndicator = document.getElementById("offlineIndicator");
  
  const btnLogin = document.getElementById("btnLogin");
  const btnAddItem = document.getElementById("btnAddItem");
  const btnSubmitDraft = document.getElementById("btnSubmitDraft");
  const btnNewDraft = document.getElementById("btnNewDraft");
  const itemsContainer = document.getElementById("itemsContainer");
  
  const customerNameInput = document.getElementById("customerName");
  const customerSuggestions = document.getElementById("customerSuggestions");
  
  const productModal = document.getElementById("productModal");
  const btnCloseModal = document.getElementById("btnCloseModal");
  const productSearch = document.getElementById("productSearch");
  const productResults = document.getElementById("productResults");

  let currentEditingItemIndex = -1;
  let itemCount = 0;

  // 註冊 Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('Service Worker Registered!', reg))
      .catch(err => console.error('Service Worker Registration Failed:', err));
  }

  // 檢查網路連線狀態
  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);

  function updateOnlineStatus() {
    if (navigator.onLine) {
      offlineIndicator.classList.add("hidden");
      if ('serviceWorker' in navigator && 'SyncManager' in window) {
        navigator.serviceWorker.ready.then(reg => reg.sync.register('sync-drafts'));
      }
      initData(); // 恢復連線時嘗試更新資料
    } else {
      offlineIndicator.classList.remove("hidden");
    }
  }

  // 0. 初始化載入雲端資料
  async function initData() {
    try {
      if (!navigator.onLine) throw new Error("Offline");
      
      const resManifest = await fetch(`${GAS_URL}?action=get_manifest`);
      const manifest = await resManifest.json();
      
      if (manifest.products_file_id) {
        const resP = await fetch(`https://drive.google.com/uc?export=download&id=${manifest.products_file_id}`);
        if (resP.ok) {
          MOCK_PRODUCTS = await resP.json();
          localStorage.setItem("products_cache", JSON.stringify(MOCK_PRODUCTS));
        }
      }
      
      if (manifest.customers_file_id) {
        const resC = await fetch(`https://drive.google.com/uc?export=download&id=${manifest.customers_file_id}`);
        if (resC.ok) {
          MOCK_CUSTOMERS = await resC.json();
          localStorage.setItem("customers_cache", JSON.stringify(MOCK_CUSTOMERS));
        }
      }
      console.log("資料庫同步成功！", MOCK_PRODUCTS.length, "項產品");
    } catch (e) {
      console.log("無法連線雲端，讀取本機快取資料...");
      try {
        MOCK_PRODUCTS = JSON.parse(localStorage.getItem("products_cache") || "[]");
        MOCK_CUSTOMERS = JSON.parse(localStorage.getItem("customers_cache") || "[]");
      } catch(err) {}
    }
  }

  // 初始化狀態
  updateOnlineStatus();

  // 1. 登入邏輯 (簡化模擬)
  btnLogin.addEventListener("click", () => {
    loadingOverlay.classList.remove("hidden");
    
    // 若尚未載入資料，嘗試由快取載入
    if (MOCK_PRODUCTS.length === 0) {
      try {
        MOCK_PRODUCTS = JSON.parse(localStorage.getItem("products_cache") || "[]");
        MOCK_CUSTOMERS = JSON.parse(localStorage.getItem("customers_cache") || "[]");
      } catch(e) {}
    }

    setTimeout(() => {
      loadingOverlay.classList.add("hidden");
      loginSection.classList.add("hidden");
      draftSection.classList.remove("hidden");
      addBlankItem(); // 預設給一個空白品項
    }, 800);
  });

  // 2. 客戶名稱搜尋提示
  customerNameInput.addEventListener("input", (e) => {
    const val = e.target.value.toLowerCase();
    if (!val) {
      customerSuggestions.classList.add("hidden");
      return;
    }
    
    const matches = MOCK_CUSTOMERS.filter(c => {
      const name = typeof c === 'string' ? c : (c.name || "");
      return name.toLowerCase().includes(val);
    });
    if (matches.length > 0) {
      customerSuggestions.innerHTML = matches.map(c => {
        const name = typeof c === 'string' ? c : (c.name || "");
        return `<div class="suggestion-item">${name}</div>`;
      }).join("");
      customerSuggestions.classList.remove("hidden");
    } else {
      customerSuggestions.classList.add("hidden");
    }
  });

  customerSuggestions.addEventListener("click", (e) => {
    if (e.target.classList.contains("suggestion-item")) {
      customerNameInput.value = e.target.textContent;
      customerSuggestions.classList.add("hidden");
    }
  });

  // 3. 產品品項操作
  function addBlankItem() {
    itemCount++;
    const itemId = `item-${itemCount}`;
    const itemHTML = `
      <div class="item-row" id="${itemId}">
        <div class="item-header">
          <div class="item-title" id="${itemId}-title">點擊選擇產品...</div>
          <button type="button" class="item-remove" onclick="document.getElementById('${itemId}').remove()">&times;</button>
        </div>
        <div class="item-details">
          <div>
            <label>數量</label>
            <input type="number" name="quantity" min="1" value="1" required>
          </div>
          <div>
            <label>現場參考價</label>
            <input type="number" name="ref_price" placeholder="選填">
          </div>
        </div>
        <input type="hidden" name="item_code" id="${itemId}-code">
        <input type="hidden" name="item_name" id="${itemId}-name">
      </div>
    `;
    itemsContainer.insertAdjacentHTML('beforeend', itemHTML);
    
    // 綁定點擊事件以打開產品選擇 Modal
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

  // 4. Modal 與產品搜尋
  btnCloseModal.addEventListener("click", () => {
    productModal.classList.add("hidden");
  });

  productSearch.addEventListener("input", (e) => {
    const val = e.target.value.toLowerCase();
    const matches = MOCK_PRODUCTS.filter(p => 
      p.code.toLowerCase().includes(val) || p.name.toLowerCase().includes(val)
    );
    renderProducts(matches);
  });

  function renderProducts(products) {
    if (products.length === 0) {
      productResults.innerHTML = `<div class="text-center text-muted mt-3">找不到符合的產品</div>`;
      return;
    }

    productResults.innerHTML = products.map(p => {
      const stockClass = p.stock === "IN_STOCK" ? "stock-in" : "stock-out";
      const stockText = p.stock === "IN_STOCK" ? "現貨" : "期貨";
      return `
        <div class="product-item" data-code="${p.code}" data-name="${p.name}">
          <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
            <strong>${p.code}</strong>
            <span class="stock-badge ${stockClass}">${stockText}</span>
          </div>
          <div style="color:var(--text-muted); font-size:0.875rem;">${p.name}</div>
        </div>
      `;
    }).join("");
  }

  productResults.addEventListener("click", (e) => {
    const item = e.target.closest(".product-item");
    if (item && currentEditingItemIndex) {
      const code = item.dataset.code;
      const name = item.dataset.name;
      
      document.getElementById(`${currentEditingItemIndex}-title`).textContent = `[${code}] ${name}`;
      document.getElementById(`${currentEditingItemIndex}-title`).style.color = "var(--text-main)";
      document.getElementById(`${currentEditingItemIndex}-code`).value = code;
      document.getElementById(`${currentEditingItemIndex}-name`).value = name;
      
      productModal.classList.add("hidden");
    }
  });

  // 5. 送出草稿
  document.getElementById("draftForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    
    // 收集資料
    const customer = customerNameInput.value;
    const items = [];
    const itemRows = itemsContainer.querySelectorAll(".item-row");
    
    if (itemRows.length === 0) {
      alert("請至少加入一個品項");
      return;
    }

    let hasError = false;
    itemRows.forEach(row => {
      const code = row.querySelector("input[name='item_code']").value;
      const name = row.querySelector("input[name='item_name']").value;
      const qty = row.querySelector("input[name='quantity']").value;
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
      email: "sales@example.com", // 實務上從 OAuth 取得
      customer: customer,
      items: items,
      timestamp: new Date().toISOString()
    };

    if (navigator.onLine) {
      // 連線狀態，直接發送
      loadingOverlay.classList.remove("hidden");
      try {
        // 實務上呼叫 GAS_URL
        const res = await fetch(`${GAS_URL}?action=draft`, {
          method: 'POST',
          body: JSON.stringify(draftData),
          headers: {
            'Content-Type': 'text/plain;charset=utf-8' // 避免 CORS preflight option 問題
          }
        });
        
        const resData = await res.json();
        if (resData.status !== "ok") {
          throw new Error(resData.msg || "未知錯誤");
        }
        
        loadingOverlay.classList.add("hidden");
        draftSection.classList.add("hidden");
        successSection.classList.remove("hidden");
      } catch (err) {
        loadingOverlay.classList.add("hidden");
        alert("上傳失敗，請稍後再試: " + err.message);
      }
    } else {
      // 離線狀態，存入 localStorage
      let drafts = JSON.parse(localStorage.getItem("offlineDrafts") || "[]");
      drafts.push(draftData);
      localStorage.setItem("offlineDrafts", JSON.stringify(drafts));
      
      draftSection.classList.add("hidden");
      successSection.classList.remove("hidden");
      // 可在此註冊 Background Sync
    }
  });

  btnNewDraft.addEventListener("click", () => {
    customerNameInput.value = "";
    itemsContainer.innerHTML = "";
    addBlankItem();
    
    successSection.classList.add("hidden");
    draftSection.classList.remove("hidden");
  });

  // ========== OCR 邏輯 ==========
  const btnNewCustomer = document.getElementById("btnNewCustomer");
  const customerOcrModal = document.getElementById("customerOcrModal");
  const btnCloseOcr = document.getElementById("btnCloseOcr");
  const cameraInput = document.getElementById("cameraInput");
  const btnTriggerCamera = document.getElementById("btnTriggerCamera");
  const ocrResultForm = document.getElementById("ocrResultForm");
  const btnSaveOcrCustomer = document.getElementById("btnSaveOcrCustomer");

  if (btnNewCustomer) {
    btnNewCustomer.addEventListener("click", () => {
      customerOcrModal.classList.remove("hidden");
      ocrResultForm.classList.add("hidden");
    });
    
    btnCloseOcr.addEventListener("click", () => {
      customerOcrModal.classList.add("hidden");
    });
    
    btnTriggerCamera.addEventListener("click", () => {
      cameraInput.click();
    });
    
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
      const url = `${GAS_URL}?action=ocr_card`;
      
      const body = {
        data: base64Str,
        mimeType: mimeType
      };

      const res = await fetch(url, {
        method: "POST",
        headers: {"Content-Type": "text/plain;charset=utf-8"},
        body: JSON.stringify(body)
      });
      
      if (!res.ok) throw new Error(`網路錯誤: ${res.status}`);
      
      const resData = await res.json();
      if (resData.status !== "ok") {
        throw new Error(resData.msg || "未知錯誤");
      }
      
      const result = resData.data;
      
      document.getElementById("ocrCompany").value = result.name || "";
      document.getElementById("ocrTaxId").value = result.tax_id || "";
      document.getElementById("ocrContact").value = result.contact || "";
      document.getElementById("ocrAddress").value = result.address || "";
      document.getElementById("ocrPhone").value = result.phone || "";
      document.getElementById("ocrMobile").value = result.mobile || "";
      
      ocrResultForm.classList.remove("hidden");
    }

    btnSaveOcrCustomer.addEventListener("click", async () => {
      const name = document.getElementById("ocrCompany").value.trim();
      if (!name) {
        alert("公司名稱不能為空");
        return;
      }
      
      const newCustomer = {
        id: "C" + Date.now(),
        name: name,
        tax_id: document.getElementById("ocrTaxId").value.trim(),
        phone: document.getElementById("ocrPhone").value.trim(),
        fax: "",
        address: document.getElementById("ocrAddress").value.trim(),
        payment_terms: "現金",
        status: "active",
        default_discount: 1.0,
        contacts: [
          {
            id: "CT" + Date.now(),
            name: document.getElementById("ocrContact").value.trim(),
            email: "",
            mobile: document.getElementById("ocrMobile").value.trim()
          }
        ]
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
      } catch(e) {
          alert("儲存至雲端失敗: " + e.message + "\n(請確認後端 GAS 已更新版本)");
      } finally {
          loadingOverlay.classList.add("hidden");
      }
    });
  }

});
