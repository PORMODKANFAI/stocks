<script>
  /**
 * api.js
 * แทนที่ google.script.run ด้วย fetch() ไปยัง Apps Script Web App
 * ใช้รูปแบบเดิมให้มากที่สุดเพื่อลดการแก้ไข app.js
 */

const API_URL = window.APP_CONFIG?.API_URL || '';

/**
 * เรียก Apps Script function ผ่าน HTTP POST
 * คืนค่า Promise<any>
 */
async function callAPI(action, params = {}) {
  if (!API_URL) throw new Error('กรุณาตั้งค่า API_URL ใน config.js');
  
  const response = await fetch(API_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'text/plain' }, //
    /**
 * api.js
 * แทนที่ google.script.run ด้วย fetch() ไปยัง Apps Script Web App
 */

const API_URL = window.APP_CONFIG?.API_URL || '';

/**
 * เรียก Apps Script function ผ่าน HTTP POST
 * หมายเหตุ: ต้องใช้ Content-Type: text/plain เพราะ Apps Script
 * ไม่รองรับ application/json สำหรับ CORS preflight-free request
 */
async function callAPI(action, params = {}) {
  if (!API_URL) throw new Error('กรุณาตั้งค่า API_URL ใน config.js');

  try {
    const response = await fetch(API_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' }, // ← ไม่ trigger CORS preflight
      body:    JSON.stringify({ action, params }),
      redirect: 'follow'  // Apps Script redirect เสมอ
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('API ตอบกลับไม่ใช่ JSON: ' + text.substring(0, 100));
    }
  } catch (err) {
    // Network error / CORS
    if (err.name === 'TypeError' && err.message.includes('fetch')) {
      throw new Error('ไม่สามารถเชื่อมต่อ API ได้ — ตรวจสอบ API_URL และ deployment settings');
    }
    throw err;
  }
}

/**
 * google — object จำลอง google.script.run
 * ใช้แทนได้เลยโดยไม่ต้องแก้ app.js มาก
 *
 * ตัวอย่างการใช้:
 *   google.script.run
 *     .withSuccessHandler(d => { ... })
 *     .withFailureHandler(e => { ... })
 *     .getStockData();
 */
const google = {
  script: {
    run: new Proxy({}, {
      get(_, fnName) {
        // คืน builder object ที่ chain ได้
        return _makeRunner(fnName);
      }
    })
  }
};

function _makeRunner(fnName) {
  const runner = {
    _onSuccess: null,
    _onFailure: null,
    _params:    [],

    withSuccessHandler(fn) {
      this._onSuccess = fn;
      return this;
    },
    withFailureHandler(fn) {
      this._onFailure = fn;
      return this;
    }
  };

  // Proxy เพื่อดักจับ .functionName(...args) ที่ท้าย chain
  return new Proxy(runner, {
    get(target, prop) {
      // ถ้า prop มีอยู่ใน runner ให้คืนค่าปกติ (withSuccessHandler, withFailureHandler)
      if (prop in target) return target[prop].bind(target);

      // ถ้าไม่มี → เป็นชื่อ function ที่ต้องการเรียก
      return (...args) => {
        // แปลง args → params object ตาม action ที่รู้จัก
        const params = _argsToParams(prop, args);

        callAPI(prop, params)
          .then(result => {
            if (target._onSuccess) target._onSuccess(result);
          })
          .catch(err => {
            console.error(`[API] ${prop} failed:`, err);
            if (target._onFailure) target._onFailure({ message: err.message });
            else console.error('Unhandled API error:', err);
          });
      };
    }
  });
}

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