<script>
 /* ════════════════════════════════════════
   api.js — REST API client for GitHub Pages
   เรียก Google Apps Script Web App ผ่าน fetch()
════════════════════════════════════════ */

// ดึง API URL จาก config.js หรือ localStorage
function getAPIUrl() {
  return localStorage.getItem('gas_api_url')
      || window.APP_CONFIG?.API_URL
      || '';
}

// ── Health Check ──
async function checkAPIHealth() {
  const t0 = Date.now();
  try {
    const url = getAPIUrl();
    if (!url) return { ok: false, error: 'ยังไม่ได้ตั้งค่า API URL' };
    const res = await fetch(`${url}?action=ping`, { method: 'GET' });
    const data = await res.json();
    return { ok: true, latency: Date.now() - t0, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Core API caller ──
async function callAPI(action, payload = {}) {
  const url = getAPIUrl();
  if (!url) throw new Error('ยังไม่ได้ตั้งค่า API URL');

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' }, // ต้องใช้ text/plain กับ GAS
      body:    JSON.stringify({ action, ...payload })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data;
  } catch (e) {
    console.error(`[API] ${action} failed:`, e);
    throw e;
  }
}

// ── สร้าง google.script.run emulator ──
// ให้ code เดิมทำงานได้โดยไม่ต้องแก้ทุกที่
window.google = {
  script: {
    run: new Proxy({}, {
      get(_, action) {
        let _successCb = null;
        let _failCb    = null;

        const runner = {
          withSuccessHandler(cb) { _successCb = cb; return runner; },
          withFailureHandler(cb) { _failCb    = cb; return runner; },

          // method call: google.script.run.withSuccessHandler(cb).getPersonnelData()
          // Proxy trap ต้องรับ args ของ function นั้น
        };

        // Return function ที่เรียก API
        return new Proxy(runner, {
          apply(target, thisArg, args) {
            // ถูกเรียกเป็น function: google.script.run.getPersonnelData()
            callAPI(action, args[0] || {})
              .then(data => _successCb && _successCb(data))
              .catch(err => _failCb
                ? _failCb(err)
                : console.error(action, err)
              );
            return runner;
          },
          get(target, prop) {
            if (prop in runner) return runner[prop];
            // runner.getPersonnelData() — method chaining
            return (...args) => {
              callAPI(action, args[0] || {})
                .then(data => _successCb && _successCb(data))
                .catch(err => _failCb
                  ? _failCb(err)
                  : console.error(action, err)
                );
              return runner;
            };
          }
        });
      }
    })
  }
};

/**
 * แปลง positional arguments → params object
 * ให้ตรงกับที่ Apps Script ต้องการ
 */
function _argsToParams(action, args) {
  const map = {
    verifyLogin:          ([userId, password])    => ({ userId, password }),
    verifyPersonPassword: ([userId, password])    => ({ userId, password }),
    savePersonnel:        ([personData])           => ({ personData }),
    deletePersonnel:      ([rowIndex])             => ({ rowIndex }),
    changeAdminPassword:  ([newPwd])               => ({ newPwd }),
    addStockItem:         ([item])                 => ({ item }),
    submitRequest:        ([formData])             => ({ formData }),
    submitReceive:        ([formData])             => ({ formData }),
    getHistory:           ([filters])              => ({ filters: filters || {} }),
    getReport:            ([startDate, endDate, type]) => ({ startDate, endDate, type }),
    saveTelegramConfig:   ([cfg])                  => ({ cfg }),
    // ฟังก์ชันที่ไม่มี params
    getPersonnelData:     ()                       => ({}),
    getStockData:         ()                       => ({}),
    getDashboardStats:    ()                       => ({}),
    getTelegramConfig:    ()                       => ({}),
    testTelegramMessage:  ()                       => ({}),
    initializeSheets:     ()                       => ({}),
  };

  const converter = map[action];
  if (converter) return converter(args);

  // fallback: ถ้าไม่รู้จัก action ส่ง args ทั้งหมดเป็น array
  console.warn(`[API] Unknown action "${action}" — sending raw args`);
  return { args };
}

/* ─────────────────────────────────────────
   CACHE LAYER (optional)
   Cache ข้อมูลที่ไม่เปลี่ยนบ่อย เช่น stock, personnel
   เพื่อลด API calls
───────────────────────────────────────── */
const _cache = new Map();
const CACHE_TTL = {
  getStockData:      30_000,  // 30 วินาที
  getPersonnelData:  60_000,  // 1 นาที
  getDashboardStats: 20_000,  // 20 วินาที
};

/**
 * callAPI พร้อม cache
 * ใช้แทน callAPI สำหรับ read-only endpoints
 */
async function callAPICached(action, params = {}) {
  const ttl = CACHE_TTL[action];
  if (!ttl) return callAPI(action, params); // ไม่ cache write operations

  const key = action + JSON.stringify(params);
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.ts < ttl) {
    return cached.data;
  }

  const data = await callAPI(action, params);
  _cache.set(key, { data, ts: Date.now() });
  return data;
}

/** ล้าง cache ทั้งหมด (เรียกหลัง write operations) */
function clearAPICache() {
  _cache.clear();
}

/* ─────────────────────────────────────────
   HEALTH CHECK
   ตรวจสอบว่า API ทำงานได้หรือไม่
───────────────────────────────────────── */
async function checkAPIHealth() {
  try {
    const start = Date.now();
    const res   = await callAPI('initializeSheets', {});
    const ms    = Date.now() - start;
    console.log(`[API] Health OK — ${ms}ms`, res);
    return { ok: true, latency: ms };
  } catch (e) {
    console.error('[API] Health FAIL', e);
    return { ok: false, error: e.message };
  }
}

</script>
