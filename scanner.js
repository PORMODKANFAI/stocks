<script>
  /**
 * scanner.js
 * QR/Barcode Scanner Module
 * รองรับ: เว็บแคม PC, กล้องมือถือ (front/back), input file
 */

/* ─────────────────────────────────────────
   STATE
───────────────────────────────────────── */
let _scanMode        = 'stock';
let _html5QrScanner  = null;
let _scanLocked      = false;
let _currentCamera   = 'environment'; // 'environment' = หลัง, 'user' = หน้า
let _availableCameras = [];

/* ─────────────────────────────────────────
   PUBLIC API
───────────────────────────────────────── */

/**
 * เปิด scanner overlay
 * @param {'req'|'rcv'|'stock'} mode
 */
function openGlobalScanner(mode) {
  _scanMode   = mode;
  _scanLocked = false;

  // รีเซ็ต UI
  const overlay = document.getElementById('scan-overlay');
  overlay.classList.add('show');
  _resetScanUI();

  const titles = {
    req:   'สแกนเบิกวัสดุ',
    rcv:   'สแกนรับวัสดุเข้าคลัง',
    stock: 'สแกนดูรายละเอียดวัสดุ'
  };
  document.getElementById('scan-overlay-title').textContent = titles[mode] || 'สแกน QR / Barcode';

  // เริ่มกล้องหลัง delay เล็กน้อย (รอ DOM render)
  setTimeout(() => _startCamera(), 250);
}

/**
 * ปิด scanner — ปิด overlay ทันที แล้วค่อย stop กล้อง async
 */
function closeGlobalScanner() {
  // 1. ซ่อน overlay ทันที
  document.getElementById('scan-overlay').classList.remove('show');

  // 2. ล้าง reader DOM
  const el = document.getElementById('scan-qr-reader');
  if (el) el.innerHTML = '';

  // 3. รีเซ็ต state
  _scanLocked = false;
  document.getElementById('scan-result-bar').classList.remove('show');

  // 4. Stop กล้อง async (ไม่รอ)
  _stopCamera();
}

/**
 * สลับกล้อง หน้า/หลัง
 */
function switchCamera() {
  _currentCamera = _currentCamera === 'environment' ? 'user' : 'environment';
  _stopCamera();
  setTimeout(() => _startCamera(), 300);
}

/**
 * Manual scan จาก input
 */
function doManualScan() {
  const val = document.getElementById('scan-manual-input').value.trim();
  if (!val) {
    toast('กรุณาระบุรหัสหรือชื่อวัสดุ', 'warn');
    return;
  }
  _scanLocked = false;
  _onScanSuccess(val);
}

/* ─────────────────────────────────────────
   CAMERA MANAGEMENT
───────────────────────────────────────── */

async function _startCamera() {
  // ทำลาย instance เก่า
  await _stopCamera();

  const el = document.getElementById('scan-qr-reader');
  if (el) el.innerHTML = '';

  // ตรวจสอบ library
  if (typeof Html5Qrcode === 'undefined') {
    _showHint('⚠️ ไม่พบ QR library — กรุณาพิมพ์รหัสในช่องด้านล่าง', 'error');
    return;
  }

  // ตรวจสอบ camera permission
  const hasPerm = await _checkCameraPermission();
  if (!hasPerm) {
    _showHint('⚠️ ไม่ได้รับอนุญาตใช้กล้อง — พิมพ์รหัสวัสดุในช่องด้านล่างแทน', 'error');
    _showFileUploadOption(); // แสดงปุ่มเลือกรูปแทน
    return;
  }

  try {
    _html5QrScanner = new Html5Qrcode('scan-qr-reader', {
      verbose: false // ปิด log spam
    });

    // ดึงรายการกล้องที่มี
    const cameras = await Html5Qrcode.getCameras();
    _availableCameras = cameras;

    // แสดงปุ่มสลับกล้องถ้ามีมากกว่า 1
    const switchBtn = document.getElementById('scan-switch-btn');
    if (switchBtn) {
      switchBtn.style.display = cameras.length > 1 ? 'flex' : 'none';
    }

    // เลือกกล้องที่เหมาะสม
    const cameraId = _selectBestCamera(cameras);

    const config = {
      fps:          15,
      qrbox:        _getQRBoxSize(),
      aspectRatio:  1.0,
      // รองรับทั้ง QR และ Barcode
      formatsToSupport: _getSupportedFormats()
    };

    await _html5QrScanner.start(
      cameraId,
      config,
      (decodedText, decodedResult) => {
        _onScanSuccess(decodedText, decodedResult);
      },
      (errorMsg) => {
        // ข้อผิดพลาดระหว่างสแกน (ไม่ใช่ error จริง เป็น "ยังไม่พบ QR")
        // ไม่ต้องทำอะไร
      }
    );

    _showHint('🎯 จ่อกล้องไปที่ QR Code หรือ Barcode ของวัสดุ');

  } catch (err) {
    console.error('[Scanner] Start error:', err);

    // ลองใช้ facingMode แทน cameraId
    if (_html5QrScanner) {
      try {
        await _html5QrScanner.start(
          { facingMode: _currentCamera },
          { fps: 12, qrbox: { width: 200, height: 200 } },
          (text) => _onScanSuccess(text),
          () => {}
        );
        _showHint('🎯 จ่อกล้องไปที่ QR Code หรือ Barcode ของวัสดุ');
        return;
      } catch (e2) {
        console.error('[Scanner] Fallback error:', e2);
      }
    }

    _showHint('⚠️ ไม่สามารถเปิดกล้องได้ — ลองพิมพ์รหัสวัสดุในช่องด้านล่าง', 'error');
    _showFileUploadOption();
  }
}

/**
 * Stop กล้อง — ไม่รอ promise (fire and forget)
 */
function _stopCamera() {
  if (!_html5QrScanner) return Promise.resolve();

  const scanner = _html5QrScanner;
  _html5QrScanner = null;

  return new Promise(resolve => {
    try {
      scanner.stop()
        .then(() => resolve())
        .catch(() => resolve()); // ละเว้น error
    } catch {
      resolve();
    }
  });
}

/* ─────────────────────────────────────────
   SCAN RESULT HANDLER
───────────────────────────────────────── */

function _onScanSuccess(rawText, decodedResult) {
  if (_scanLocked) return;
  _scanLocked = true;

  // เสียง beep (optional)
  _playBeep();

  // Parse format: "STH001|ชื่อวัสดุ|จำนวน"
  const parts      = rawText.trim().split('|');
  const code       = parts[0] || '';
  const nameFromQR = parts[1] || '';

  // ค้นหาในรายการวัสดุ (STOCK_DATA_FOR_QR มาจาก app.js)
  let item = null;

  // 1. ค้นหาตามรหัส
  if (code) item = STOCK_DATA_FOR_QR.find(s => s.code === code);

  // 2. ค้นหาตามชื่อจาก QR
  if (!item && nameFromQR) item = STOCK_DATA_FOR_QR.find(s => s.name === nameFromQR);

  // 3. ค้นหาตามชื่อตรงๆ (กรณีสแกน barcode ที่เป็นชื่อ)
  if (!item) item = STOCK_DATA_FOR_QR.find(
    s => s.name.toLowerCase() === rawText.toLowerCase().trim()
  );

  // 4. ค้นหาแบบ partial match
  if (!item && rawText.length >= 3) {
    item = STOCK_DATA_FOR_QR.find(
      s => s.name.toLowerCase().includes(rawText.toLowerCase().trim()) ||
           s.code.toLowerCase().includes(rawText.toLowerCase().trim())
    );
  }

  if (!item) {
    _showScanError(rawText);
    setTimeout(() => {
      _scanLocked = false;
      document.getElementById('scan-result-bar').classList.remove('show');
    }, 2000);
    return;
  }

  // พบวัสดุ!
  _showScanSuccess(item);

  setTimeout(() => {
    closeGlobalScanner();

    if (_scanMode === 'stock') {
      showQRDetail(item.code, item.name, item.unit, item.qty, item.status, item.qrUrl);
    } else {
      _applyScannedItemToForm(_scanMode, item);
    }
  }, 600);
}

/* ─────────────────────────────────────────
   UI HELPERS
───────────────────────────────────────── */

function _resetScanUI() {
  document.getElementById('scan-result-bar').classList.remove('show');
  document.getElementById('scan-manual-input').value  = '';
  _showHint('กำลังเปิดกล้อง...');

  // ซ่อน file upload ถ้ามี
  const fu = document.getElementById('scan-file-upload-wrap');
  if (fu) fu.style.display = 'none';
}

function _showHint(text, type = 'normal') {
  const el = document.getElementById('scan-hint');
  if (!el) return;
  el.textContent = text;
  el.style.color  = type === 'error' ? '#fca5a5' : 'rgba(255,255,255,.55)';
}

function _showScanSuccess(item) {
  const bar = document.getElementById('scan-result-bar');
  bar.style.background   = 'rgba(14,165,160,.18)';
  bar.style.borderColor  = 'rgba(14,165,160,.5)';

  const iconWrap = bar.querySelector('.scan-result-icon');
  if (iconWrap) {
    iconWrap.style.background = 'var(--teal)';
    const ic = document.getElementById('scan-result-icon-i');
    if (ic) ic.className = 'bx bx-check';
  }

  const nameEl = document.getElementById('scan-result-name');
  const subEl  = document.getElementById('scan-result-sub');
  if (nameEl) nameEl.textContent = item.name;
  if (subEl)  subEl.textContent  = `คงเหลือ: ${item.qty} ${item.unit}`;

  bar.classList.add('show');
}

function _showScanError(rawText) {
  const bar = document.getElementById('scan-result-bar');
  bar.style.background  = 'rgba(239,68,68,.18)';
  bar.style.borderColor = 'rgba(239,68,68,.5)';

  const iconWrap = bar.querySelector('.scan-result-icon');
  if (iconWrap) {
    iconWrap.style.background = 'var(--red)';
    const ic = document.getElementById('scan-result-icon-i');
    if (ic) ic.className = 'bx bx-error';
  }

  const nameEl = document.getElementById('scan-result-name');
  const subEl  = document.getElementById('scan-result-sub');
  if (nameEl) nameEl.textContent = '⚠️ ไม่พบวัสดุในระบบ';
  if (subEl)  subEl.textContent  = rawText.substring(0, 50);

  bar.classList.add('show');
  toast('ไม่พบวัสดุ: ' + rawText.substring(0, 30), 'warn');
}

/**
 * แสดงตัวเลือก upload รูปสำหรับสแกน QR จากรูปภาพ
 * (สำรองกรณีกล้องไม่ทำงาน)
 */
function _showFileUploadOption() {
  let wrap = document.getElementById('scan-file-upload-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'scan-file-upload-wrap';
    wrap.style.cssText = 'width:100%;max-width:400px;text-align:center;';
    wrap.innerHTML = `
      <div style="color:rgba(255,255,255,.4);font-size:12px;margin-bottom:8px;">
        หรือเลือกรูปภาพที่มี QR Code
      </div>
      <label style="
        display:inline-flex;align-items:center;gap:8px;
        padding:10px 20px;background:rgba(255,255,255,.1);
        border:1.5px solid rgba(255,255,255,.2);border-radius:8px;
        color:#fff;font-size:13px;cursor:pointer;transition:all .2s;
      ">
        <i class='bx bx-image-add' style="font-size:18px;"></i>
        เลือกรูปภาพ
        <input type="file" accept="image/*" id="scan-file-input"
          style="display:none;" onchange="scanFromFile(this)">
      </label>
    `;
    document.querySelector('.scan-body')?.appendChild(wrap);
  }
  wrap.style.display = 'block';
}

/**
 * สแกน QR จากรูปภาพ (กรณีกล้องไม่ทำงาน)
 */
async function scanFromFile(input) {
  if (!input.files?.length) return;
  const file = input.files[0];

  if (typeof Html5Qrcode === 'undefined') {
    toast('ไม่พบ QR library', 'err');
    return;
  }

  _showHint('กำลังสแกนรูปภาพ...');

  try {
    const scanner = new Html5Qrcode('scan-qr-reader-file');
    const result  = await Html5Qrcode.scanFile(file, true);
    scanner.clear?.();
    _scanLocked = false;
    _onScanSuccess(result);
  } catch (e) {
    _showHint('ไม่พบ QR Code ในรูปภาพ — ลองพิมพ์รหัสด้านล่าง', 'error');
    toast('ไม่พบ QR Code ในรูปภาพ', 'warn');
  }

  input.value = ''; // reset
}

/* ─────────────────────────────────────────
   CAMERA UTILITIES
───────────────────────────────────────── */

/**
 * ตรวจสอบ permission กล้อง
 */
async function _checkCameraPermission() {
  // ตรวจสอบว่ามี getUserMedia หรือไม่
  if (!navigator.mediaDevices?.getUserMedia) return false;

  try {
    // ตรวจสอบ permission API (ไม่รองรับทุก browser)
    if (navigator.permissions) {
      const perm = await navigator.permissions.query({ name: 'camera' });
      if (perm.state === 'denied') return false;
    }
    return true;
  } catch {
    return true; // ถ้า permissions API ไม่รองรับ ให้ลองเปิดกล้องเลย
  }
}

/**
 * เลือกกล้องที่ดีที่สุด
 * ถ้าเป็นมือถือ → เลือกกล้องหลัง
 * ถ้าเป็น PC → เลือกกล้องแรก (เว็บแคม)
 */
function _selectBestCamera(cameras) {
  if (!cameras?.length) return { facingMode: _currentCamera };

  if (cameras.length === 1) return cameras[0].id;

  // หากล้องหลัง
  if (_currentCamera === 'environment') {
    const backCam = cameras.find(c =>
      c.label.toLowerCase().includes('back')   ||
      c.label.toLowerCase().includes('rear')   ||
      c.label.toLowerCase().includes('หลัง')   ||
      c.label.toLowerCase().includes('environment')
    );
    if (backCam) return backCam.id;
    return cameras[cameras.length - 1].id; // มักเป็นกล้องหลัง
  }

  // หากล้องหน้า
  const frontCam = cameras.find(c =>
    c.label.toLowerCase().includes('front') ||
    c.label.toLowerCase().includes('user')  ||
    c.label.toLowerCase().includes('หน้า')
  );
  return frontCam ? frontCam.id : cameras[0].id;
}

/**
 * คำนวณขนาด QR box ตามหน้าจอ
 */
function _getQRBoxSize() {
  const w = Math.min(window.innerWidth, 400);
  const size = Math.min(Math.floor(w * 0.6), 250);
  return { width: size, height: size };
}

/**
 * รายการ format ที่รองรับ
 */
function _getSupportedFormats() {
  if (typeof Html5QrcodeSupportedFormats === 'undefined') return undefined;
  return [
    Html5QrcodeSupportedFormats.QR_CODE,
    Html5QrcodeSupportedFormats.EAN_13,
    Html5QrcodeSupportedFormats.EAN_8,
    Html5QrcodeSupportedFormats.CODE_128,
    Html5QrcodeSupportedFormats.CODE_39,
    Html5QrcodeSupportedFormats.UPC_A,
    Html5QrcodeSupportedFormats.UPC_E,
    Html5QrcodeSupportedFormats.DATA_MATRIX,
  ];
}

/**
 * เสียง beep เมื่อสแกนสำเร็จ
 */
function _playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 1200;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.15);
  } catch { /* ละเว้นถ้าไม่รองรับ */ }
}

/* ─────────────────────────────────────────
   APPLY SCANNED ITEM TO FORM
   (ย้ายมาจาก app.js เพื่อรวมไว้ที่นี่)
───────────────────────────────────────── */

function _applyScannedItemToForm(formType, item) {
  const isMob  = window.innerWidth < 768;
  const prefix = formType === 'req' ? 'r' : 'v';
  const total  = formType === 'req' ? rN : vN;

  // หาแถวที่ว่างอยู่
  let targetRow = -1;
  for (let i = 1; i <= total; i++) {
    const selId = isMob ? `${prefix}ic${i}` : `${prefix}i${i}`;
    const sel   = document.getElementById(selId);
    if (sel && !sel.value) { targetRow = i; break; }
  }

  if (targetRow === -1) {
    // ไม่มีแถวว่าง — เพิ่มแถวใหม่
    if (formType === 'req') addReqRow();
    else addRcvRow();
    targetRow = formType === 'req' ? rN : vN;
  }

  // รอให้ DOM render แถวใหม่
  setTimeout(() => {
    const selId = isMob ? `${prefix}ic${targetRow}` : `${prefix}i${targetRow}`;
    const sel   = document.getElementById(selId);
    if (!sel) return;

    sel.value = item.name;

    // trigger sync
    if (formType === 'req') syncR(sel, targetRow, isMob);
    else                    syncV(sel, targetRow, isMob);

    // อัปเดต QR thumbnail
    _updateRowQR(formType, targetRow, item);

    // focus ช่องจำนวน
    const qId = isMob ? `${prefix}qc${targetRow}` : `${prefix}q${targetRow}`;
    setTimeout(() => {
      const qEl = document.getElementById(qId);
      if (qEl) { qEl.focus(); qEl.select(); }
    }, 100);
     toast(`✓ เพิ่ม "${item.name}" แถวที่ ${targetRow}`);
  }, 80);
}

function _updateRowQR(formType, i, item) {
  // อัปเดต QR thumbnail ในตาราง (desktop)
  const thumbId   = `${formType}-row-qr-${i}`;
  const thumb     = document.getElementById(thumbId);
  // อัปเดต QR thumbnail ใน card (mobile)
  const cardThumbId = `${formType}-card-qr-${i}`;
  const cardThumb   = document.getElementById(cardThumbId);

  const _setThumb = (el) => {
    if (!el || !item?.qrUrl) return;
    el.innerHTML = `<img src="${item.qrUrl}" alt="QR"
      style="width:100%;height:100%;object-fit:cover;border-radius:4px;">`;
    el.title   = item.name;
    el.onclick = () => showQRDetail(
      item.code, item.name, item.unit, item.qty, item.status, item.qrUrl
    );
    el.classList.remove('empty');
  };

  _setThumb(thumb);
  _setThumb(cardThumb);
}

/* ─────────────────────────────────────────
   KEYBOARD SHORTCUT
───────────────────────────────────────── */
document.addEventListener('keydown', e => {
  // ESC → ปิด scanner
  if (e.key === 'Escape') {
    const overlay = document.getElementById('scan-overlay');
    if (overlay?.classList.contains('show')) {
      closeGlobalScanner();
    }
  }
  // S → เปิด scanner (ถ้าไม่ได้อยู่ใน input)
  if (e.key === 's' || e.key === 'S') {
    const tag = document.activeElement?.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
      const activePage = document.querySelector('.page.active')?.id || '';
      if (activePage === 'page-stock')        openGlobalScanner('stock');
      else if (activePage === 'page-form-request') openGlobalScanner('req');
      else if (activePage === 'page-form-receive') openGlobalScanner('rcv');
    }
  }
});

</script>