const GAS_URL = 
    'https://script.google.com/macros/s/AKfycbwDzGixiLj0AwYLdCitPc0z4laVb8EEh_aQdBbbpyFkcGVdGrmZD2NRq6Mn5GJcchJG/exec';

let productsCache = [];
let editingProductCode = null;
let html5QrCodeInstance = null;

// เก็บรายการกล้องทั้งหมด และ index ของกล้องที่ใช้งานอยู่
let camerasList = [];
let currentCameraIndex = 0;
// สถานะการเปิดแฟลช (torch) ในขณะสแกน
let isFlashOn = false;

// ====== การแบ่งหน้าในตารางสินค้า ======
// กำหนดหน้าปัจจุบัน (เริ่มที่หน้าแรก) และขนาดของแต่ละหน้า
// ปรับจำนวนนี้ตามต้องการ เช่น 25 หรือ 50 รายการต่อหน้าเพื่อให้หน้าเว็บไม่ยาวเกินไป
let currentProductPage = 1;
const PRODUCT_PAGE_SIZE = 50;

// เก็บข้อความค้นหาปัจจุบันสำหรับค้นหาสินค้าในตาราง (รหัส, ชื่อ, บาร์โค้ด, หน่วย)
let productSearchQuery = '';

// Instance for barcode detection to provide distance guidance
let barcodeDetector = null;
let distanceGuideInterval = null;

// --------- LOGO สำหรับใส่ใน Excel (วาง logo.png ไว้โฟลเดอร์เดียวกับ index.html) ----------
const LOGO_URL = 'logo.png';
let logoBase64Cache = null;

async function getLogoBase64() {
    if (logoBase64Cache) return logoBase64Cache;
    try {
        const res = await fetch(LOGO_URL);
        if (!res.ok) throw new Error('Cannot load logo file');
        const blob = await res.blob();
        const reader = new FileReader();
        return await new Promise((resolve, reject) => {
            reader.onloadend = () => {
                // ได้ data URL เช่น data:image/png;base64,....
                logoBase64Cache = reader.result;
                resolve(logoBase64Cache);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (e) {
        console.warn('โหลดโลโก้ไม่สำเร็จ', e);
        return null;
    }
}

// สลับกล้องไปยังตัวถัดไปและเริ่มสแกนใหม่
async function switchCamera() {
    // หากมีน้อยกว่าหนึ่งกล้อง ไม่ต้องสลับ
    if (!camerasList || camerasList.length < 2) {
        return;
    }
    try {
        // หยุดการสแกนกล้องปัจจุบัน
        if (html5QrCodeInstance) {
            await html5QrCodeInstance.stop();
            await html5QrCodeInstance.clear();
        }
    } catch (err) {
        console.warn("Error stopping scanner during switch", err);
    }
    // คำนวณ index ของกล้องถัดไป
    currentCameraIndex = (currentCameraIndex + 1) % camerasList.length;
    const selectedDeviceId = camerasList[currentCameraIndex].id;
    // เริ่มสแกนด้วยกล้องใหม่
    try {
        await startQrWithCamera(selectedDeviceId);
    } catch (err) {
        console.error("Failed to switch camera", err);
        showStatus("scanStatus", "❌ ไม่สามารถสลับกล้องได้", "error");
    }
}

// ====== การจัดการแฟลช (Torch) ======
// ปุ่ม toggle แฟลช จะสลับสถานะแฟลชและอัปเดตข้อความบนปุ่ม
async function toggleFlash() {
    const btn = document.getElementById('flashToggleBtn');
    // หากไม่มี instance หรือปุ่มไม่พร้อม ไม่ต้องทำอะไร
    if (!html5QrCodeInstance || !btn) return;
    try {
        isFlashOn = !isFlashOn;
        // ขอใช้ torch ผ่าน applyVideoConstraints
        await html5QrCodeInstance.applyVideoConstraints({
            advanced: [{ torch: isFlashOn }]
        });
        // ปรับข้อความบนปุ่มตามสถานะ
        btn.textContent = isFlashOn ? '💡 ปิดแฟลช' : '💡 เปิดแฟลช';
        // แสดงปุ่มเมื่อใช้งานได้
        btn.style.display = 'inline-block';
    } catch (err) {
        console.warn('Toggle flash failed', err);
        showStatus('scanStatus', '⚠️ ไม่รองรับการเปิดแฟลช', 'error');
        // ซ่อนปุ่มหากไม่รองรับ
        btn.style.display = 'none';
    }
}

// เปิดแฟลชอัตโนมัติเมื่อเริ่มสแกน (ถ้าใช้งานได้)
async function autoTurnOnFlash() {
    const btn = document.getElementById('flashToggleBtn');
    if (!html5QrCodeInstance || !btn) return;
    try {
        await html5QrCodeInstance.applyVideoConstraints({
            advanced: [{ torch: true }]
        });
        isFlashOn = true;
        btn.textContent = '💡 ปิดแฟลช';
        btn.style.display = 'inline-block';
    } catch (err) {
        // หากเปิดไม่ได้ ให้ตั้งสถานะเป็นปิดและซ่อนปุ่ม
        isFlashOn = false;
        btn.textContent = '💡 เปิดแฟลช';
        btn.style.display = 'none';
    }
}

// แสดงหรือซ่อน overlay loading ในกรอบสแกนบาร์โค้ด
function showFocusLoading(show) {
    const overlay = document.getElementById('focusLoading');
    if (!overlay) return;
    // เราไม่ต้องการแสดง overlay loading อีกแล้ว ดังนั้นให้ซ่อนเสมอ
    overlay.style.display = 'none';
}

// ปรับความสูงของตารางสินค้าที่สแกนให้เต็มพื้นที่ที่เหลือของหน้าจอ
function adjustScannedTableHeight() {
    try {
        const scanTab = document.getElementById('tab-scan');
        const header = document.querySelector('.header');
        if (!scanTab || !header) return;
        const cards = scanTab.querySelectorAll('.card');
        if (!cards || cards.length < 2) return;
        const scannedCard = cards[1];
        const tableContainer = scannedCard.querySelector('.table-container');
        if (!tableContainer) return;
        // คำนวณพื้นที่ว่างในหน้าจอ: ความสูงของ viewport ลบด้วยความสูงของส่วนหัวและส่วนสแกนแรก
        const viewportHeight = window.innerHeight;
        const headerHeight = header.getBoundingClientRect().height;
        const scanCard = cards[0];
        const scanCardHeight = scanCard ? scanCard.getBoundingClientRect().height : 0;
        // ความสูงของส่วนที่อยู่ภายใน scannedCard ที่ไม่ใช่ table (เช่น heading, ปุ่ม action, padding)
        const headingEl = scannedCard.querySelector('h3');
        const actionsEl = scannedCard.querySelector('.action-buttons');
        const headingHeight = headingEl ? headingEl.getBoundingClientRect().height : 0;
        const actionsHeight = actionsEl ? actionsEl.getBoundingClientRect().height : 0;
        const style = window.getComputedStyle(scannedCard);
        const paddingTop = parseFloat(style.paddingTop) || 0;
        const paddingBottom = parseFloat(style.paddingBottom) || 0;
        const padding = paddingTop + paddingBottom;
        // margin เผื่อรวมช่องว่างอื่น ๆ (ช่องว่างระหว่างการ์ดและภายใน)
        const marginBuffer = 80;
        let available = viewportHeight - headerHeight - scanCardHeight - headingHeight - actionsHeight - padding - marginBuffer;
        if (available < 100) available = 100;
        tableContainer.style.maxHeight = available + 'px';
        tableContainer.style.overflowY = 'auto';
    } catch (e) {
        console.warn('adjustScannedTableHeight error', e);
    }
}

// ====== ระบบคำแนะนำระยะห่างของบาร์โค้ด ======
// เริ่มวิเคราะห์ภาพด้วย BarcodeDetector เพื่อแนะนำให้ผู้ใช้เข้าใกล้หรือออกห่าง
function startDistanceGuide() {
    // เคลียร์ interval เดิมถ้ามี
    if (distanceGuideInterval) {
        clearInterval(distanceGuideInterval);
        distanceGuideInterval = null;
    }
    const guideEl = document.getElementById('distanceGuide');
    // ซ่อนเนื้อหาเริ่มต้น
    if (guideEl) {
        guideEl.style.display = 'block';
        guideEl.textContent = 'ปรับระยะให้อยู่ในกรอบ';
    }
    // ตรวจสอบว่าเบราว์เซอร์รองรับ BarcodeDetector หรือไม่
    if (!('BarcodeDetector' in window)) {
        return;
    }
    // ดึง element video หลังจากสแกนเริ่ม (อาจใช้เวลาในการสร้าง element)
    const getVideo = () => document.querySelector('#scanner video');
    let attempts = 0;
    const initDetector = async () => {
        const video = getVideo();
        if (!video) {
            // หากยังไม่พบวิดีโอ ให้ลองใหม่สักสองสามครั้ง
            attempts++;
            if (attempts < 10) {
                setTimeout(initDetector, 200);
            }
            return;
        }
        try {
            // ใช้รูปแบบบาร์โค้ดที่รองรับส่วนใหญ่สำหรับคำแนะนำ
            if (!barcodeDetector) {
                const supported = await BarcodeDetector.getSupportedFormats();
                // เลือกรูปแบบที่เกี่ยวข้องกับ 1D barcodes
                const desiredFormats = ['code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'codabar'];
                const formatsToUse = desiredFormats.filter(f => supported.includes(f));
                barcodeDetector = new BarcodeDetector({ formats: formatsToUse.length ? formatsToUse : supported });
            }
        } catch (err) {
            console.warn('BarcodeDetector init failed', err);
            return;
        }
        // เริ่ม interval เพื่อตรวจจับและให้คำแนะนำทุก 700ms
        distanceGuideInterval = setInterval(async () => {
            if (!barcodeDetector) return;
            const v = getVideo();
            if (!v) return;
            // หากวิดีโอหยุด (เช่น หลังหยุดสแกน) ให้จบ interval
            if (v.readyState < 2) return;
            try {
                const barcodes = await barcodeDetector.detect(v);
                if (barcodes && barcodes.length > 0) {
                    const bbox = barcodes[0].boundingBox;
                    const ratio = bbox.width / v.videoWidth;
                    // ตั้งค่า threshold เพื่อแนะนำ
                    let message = '';
                    if (ratio < 0.3) {
                        message = '➡️ เข้าใกล้บาร์โค้ดมากขึ้น';
                    } else if (ratio > 0.8) {
                        message = '⬅️ ถอยออกเล็กน้อย';
                    } else {
                        message = '⏳ กำลังอ่าน... อยู่นิ่งๆ';
                    }
                    if (guideEl) {
                        guideEl.textContent = message;
                        guideEl.style.display = 'block';
                    }
                } else {
                    // ไม่พบบาร์โค้ดในกรอบ ให้บอกว่าวางในกรอบ
                    if (guideEl) {
                        guideEl.textContent = 'วางบาร์โค้ดให้ตรงกรอบ';
                        guideEl.style.display = 'block';
                    }
                }
            } catch (err) {
                console.warn('Barcode detect error', err);
            }
        }, 700);
    };
    // เริ่มต้นการสร้าง detector และ interval
    initDetector();
}

// หยุด interval และซ่อนข้อความคำแนะนำ
function stopDistanceGuide() {
    if (distanceGuideInterval) {
        clearInterval(distanceGuideInterval);
        distanceGuideInterval = null;
    }
    const guideEl = document.getElementById('distanceGuide');
    if (guideEl) {
        guideEl.style.display = 'none';
        guideEl.textContent = '';
    }
}

// ฟังก์ชันสำหรับเริ่มสแกนด้วยกล้องตาม id ที่กำหนด
async function startQrWithCamera(selectedDeviceId) {
    if (!html5QrCodeInstance) {
        html5QrCodeInstance = new Html5Qrcode("scanner");
    }
    const config = {
        // เพิ่ม fps ให้สูงขึ้นเพื่อจับเฟรมได้รวดเร็วขึ้น
        fps: 30,
        // ตั้งกรอบสแกนให้เป็นแนวนอน (280x120)
        qrbox: { width: 280, height: 120 },
        useBarCodeDetectorIfSupported: true,
        disableFlip: true,
        // ขอความละเอียดสูงขึ้นเพื่อเพิ่มความคมชัด
        videoConstraints: {
            deviceId: { exact: selectedDeviceId },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            focusMode: "continuous"
        },
        formatsToSupport: [
            Html5QrcodeSupportedFormats.QR_CODE,
            Html5QrcodeSupportedFormats.CODE_128,
            Html5QrcodeSupportedFormats.CODE_39,
            Html5QrcodeSupportedFormats.EAN_13,
            Html5QrcodeSupportedFormats.EAN_8,
            Html5QrcodeSupportedFormats.UPC_A,
            Html5QrcodeSupportedFormats.UPC_E
        ]
    };
    // เริ่มสแกนด้วย config ที่กำหนดไว้
    await html5QrCodeInstance.start(
        { deviceId: { exact: selectedDeviceId } },
        config,
        async (decodedText) => {
            // เมื่อสแกนได้ข้อความ (บาร์โค้ด/คิวอาร์โค้ด)
            // ซ่อน overlay โหลดทันทีที่ได้ข้อมูล
            showFocusLoading(false);
            // หยุดตรวจสอบคำแนะนำระยะห่างทันทีเมื่อได้ผลลัพธ์
            stopDistanceGuide();
            const product = await findProductByBarcode(decodedText);
            if (product) {
                // เพิ่มข้อมูลในตารางสแกน
                addToTable(product);
                showStatus("scanStatus", `✅ พบสินค้า: ${product.name}`, "success");
                // ปิดกล้องและโฟกัสไปที่ช่องจำนวนทันที
                await stopScanning();
                // โฟกัสที่ช่องจำนวนของสินค้าที่เพิ่งสแกน
                setTimeout(() => {
                    const row = document.querySelector(`tr[data-barcode="${product.barcode}"]`);
                    if (row) {
                        const input = row.querySelector('.qty-input');
                        if (input) {
                            input.focus();
                            input.select();
                        }
                    }
                }, 300);
            } else {
                // ไม่พบสินค้าในระบบ: ปิดกล้องและแสดง popup แจ้งเตือน
                await stopScanning();
                showNotFoundModal(decodedText);
            }
        },
        (err) => {
            // ไม่ต้องแสดง error ตอนสแกนแต่ละ frame
        }
    );
    // หลังเริ่มสแกนแล้ว ลองปรับการโฟกัส ซูม และเปิดแฟลชอัตโนมัติ (ถ้าเบราว์เซอร์รองรับ)
    try {
        if (typeof html5QrCodeInstance.applyVideoConstraints === 'function') {
            // หน่วงเวลาเล็กน้อยให้สตรีมทำงานก่อนค่อยตั้งค่า focus/zoom
            setTimeout(() => {
                try {
                    html5QrCodeInstance.applyVideoConstraints({
                        focusMode: "continuous",
                        advanced: [{ zoom: 2.0 }],
                    });
                } catch (e) {
                    // ไม่ต้องทำอะไร หากตั้งค่าไม่ได้
                }
            }, 1000);
        }
    } catch (e) {
        // ignore
    }

    // ไม่ต้องแสดง overlay loading ในกรอบสแกน
    showFocusLoading(false);
    // ไม่เปิดแฟลชอัตโนมัติ ให้ผู้ใช้เปิดเองผ่านปุ่มแฟลช

}

// โหลดรายการสินค้า (เรียก action=listProducts จาก Apps Script)
async function loadAllProducts() {
    try {
        const response = await fetch(`${GAS_URL}?action=listProducts`);
        const data = await response.json();
        let list = [];
        if (Array.isArray(data)) list = data;
        else if (data && Array.isArray(data.products)) list = data.products;
        productsCache = list;
        // เมื่อตัวข้อมูลสินค้าถูกโหลดใหม่ ให้รีเซ็ตหน้าให้กลับไปหน้าที่ 1
        currentProductPage = 1;
        renderProductTable();
    } catch (err) {
        console.error('Unable to load products list:', err);
        productsCache = [];
        renderProductTable();
    }
}

function renderProductTable() {
    const tbody = document.getElementById('productBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    // หากไม่มีข้อมูลสินค้าเลย ให้แสดงข้อความ placeholder และไม่ต้องแบ่งหน้า
    if (!productsCache || productsCache.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: #9ca3af; padding: 20px;">ไม่มีข้อมูลสินค้า</td></tr>`;
        // เคลียร์ pagination เมื่อไม่มีข้อมูล
        const pagEl = document.getElementById('productPagination');
        if (pagEl) pagEl.innerHTML = '';
        return;
    }
    // เตรียมรายการที่ผ่านการค้นหาก่อนตัดแบ่งหน้า
    let filteredList = Array.isArray(productsCache) ? productsCache : [];
    if (productSearchQuery && productSearchQuery.trim() !== '') {
        const q = productSearchQuery.trim().toLowerCase();
        filteredList = filteredList.filter(prod => {
            const code = String(prod.productCode || prod.productcode || '').toLowerCase();
            const name = String(prod.name || prod.productName || '').toLowerCase();
            const barcode = String(prod.barcode || '').toLowerCase();
            const unit = String(prod.unit || '').toLowerCase();
            return (
                code.includes(q) ||
                name.includes(q) ||
                barcode.includes(q) ||
                unit.includes(q)
            );
        });
    }
    // หากผลการค้นหาไม่มีข้อมูล ให้แสดงข้อความ placeholder และล้าง pagination
    if (filteredList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: #9ca3af; padding: 20px;">ไม่พบข้อมูลสินค้า</td></tr>`;
        // เคลียร์ pagination
        const pagEl = document.getElementById('productPagination');
        if (pagEl) pagEl.innerHTML = '';
        return;
    }
    // คำนวณช่วงของข้อมูลที่จะแสดงในหน้านี้
    const totalProducts = filteredList.length;
    const totalPages = Math.ceil(totalProducts / PRODUCT_PAGE_SIZE) || 1;
    // ปรับ currentProductPage ให้อยู่ในช่วงที่ถูกต้อง
    if (currentProductPage < 1) currentProductPage = 1;
    if (currentProductPage > totalPages) currentProductPage = totalPages;
    const startIndex = (currentProductPage - 1) * PRODUCT_PAGE_SIZE;
    const endIndex = startIndex + PRODUCT_PAGE_SIZE;
    const visibleProducts = filteredList.slice(startIndex, endIndex);
    // สร้างแถวสำหรับสินค้าแต่ละรายการ
    visibleProducts.forEach((prod, idx) => {
        const code = prod.productCode || prod.productcode || '';
        const name = prod.name || prod.productName || '';
        const barcode = prod.barcode || '';
        const unit = prod.unit || '';
        // ลำดับจริง (ลำดับในหน้าปัจจุบัน + ค่าสะสมจากหน้าก่อน)
        const indexNumber = startIndex + idx + 1;
        const tr = document.createElement('tr');
        tr.innerHTML = `
                    <td class="index-col">${indexNumber}</td>
                    <td>${code}</td>
                    <td>${name}</td>
                    <td>${barcode}</td>
                    <td>${unit}</td>
                    <td>
                        <button class="icon-btn edit" onclick="editProduct('${code}')">✏️</button>
                    </td>
                    <td>
                        <button class="icon-btn delete" onclick="deleteProductByCode('${code}')">🗑️</button>
                    </td>
                `;
        tbody.appendChild(tr);
    });
    // อัปเดตแถบแบ่งหน้าเมื่อมีข้อมูล
    renderProductPagination();
}

// ====== ฟังก์ชันแบ่งหน้าและควบคุมการเปลี่ยนหน้า ======
// เปลี่ยนหน้าและรีเฟรชตารางสินค้า
function changeProductPage(page) {
    const totalProducts = productsCache ? productsCache.length : 0;
    const totalPages = Math.ceil(totalProducts / PRODUCT_PAGE_SIZE) || 1;
    // ตรวจสอบว่าเลขหน้าถูกต้องหรือไม่
    if (typeof page !== 'number') page = parseInt(page);
    if (isNaN(page) || page < 1 || page > totalPages) {
        return;
    }
    currentProductPage = page;
    renderProductTable();
}

// สร้าง UI สำหรับแถบแบ่งหน้าสินค้า
function renderProductPagination() {
    const pagEl = document.getElementById('productPagination');
    if (!pagEl) return;
    // คำนวณจำนวนข้อมูลที่ผ่านการค้นหา เพื่อแสดงจำนวนหน้าที่ถูกต้อง
    let filteredList = Array.isArray(productsCache) ? productsCache : [];
    if (productSearchQuery && productSearchQuery.trim() !== '') {
        const q = productSearchQuery.trim().toLowerCase();
        filteredList = filteredList.filter(prod => {
            const code = String(prod.productCode || prod.productcode || '').toLowerCase();
            const name = String(prod.name || prod.productName || '').toLowerCase();
            const barcode = String(prod.barcode || '').toLowerCase();
            const unit = String(prod.unit || '').toLowerCase();
            return (
                code.includes(q) ||
                name.includes(q) ||
                barcode.includes(q) ||
                unit.includes(q)
            );
        });
    }
    const totalProducts = filteredList.length;
    const totalPages = Math.ceil(totalProducts / PRODUCT_PAGE_SIZE) || 1;
    // หากหน้าทั้งหมด <= 1 ไม่ต้องแสดง pagination
    if (totalPages <= 1) {
        pagEl.innerHTML = '';
        return;
    }
    const prevDisabled = currentProductPage <= 1 ? 'disabled' : '';
    const nextDisabled = currentProductPage >= totalPages ? 'disabled' : '';
    // สร้าง HTML สำหรับปุ่มและ input page
    pagEl.innerHTML = `
        <button class="btn btn-secondary btn-sm" onclick="changeProductPage(${currentProductPage - 1})" ${prevDisabled}>◀</button>
        <span style="margin: 0 6px;">หน้า</span>
        <input type="number" id="productPageInput" min="1" max="${totalPages}" value="${currentProductPage}" style="width:60px; text-align:center; border:1px solid #d1d5db; border-radius:8px; padding:4px;">
        <span style="margin: 0 6px;">/ ${totalPages}</span>
        <button class="btn btn-secondary btn-sm" onclick="changeProductPage(${currentProductPage + 1})" ${nextDisabled}>▶</button>
    `;
    // จัดให้ pagination อยู่ด้านขวา
    pagEl.style.display = 'flex';
    pagEl.style.justifyContent = 'flex-end';
    pagEl.style.alignItems = 'center';
    pagEl.style.gap = '8px';
    // กำหนดพฤติกรรมเมื่อผู้ใช้กด Enter หรือเปลี่ยนหน้าเอง
    const inputEl = pagEl.querySelector('#productPageInput');
    if (inputEl) {
        inputEl.addEventListener('keypress', function (e) {
            if (e.key === 'Enter') {
                const val = parseInt(this.value);
                if (!isNaN(val)) {
                    changeProductPage(val);
                }
            }
        });
        inputEl.addEventListener('blur', function () {
            const val = parseInt(this.value);
            if (!isNaN(val)) {
                changeProductPage(val);
            } else {
                // reset value to current page
                this.value = currentProductPage;
            }
        });

        // เมื่อคลิกหรือโฟกัสที่ช่องเลขหน้า ให้ select ข้อความทั้งหมดเพื่อให้พิมพ์ทับได้ง่าย
        // เลือกข้อความทั้งช่องเมื่อคลิกหรือโฟกัส เพื่อให้ผู้ใช้พิมพ์ทับได้สะดวก
        function selectPageInput() {
            this.select();
        }
        inputEl.addEventListener('focus', selectPageInput);
        inputEl.addEventListener('click', selectPageInput);
    }
}

function editProduct(code) {
    const prod = productsCache.find(p => String(p.productCode || p.productcode) === String(code));
    if (!prod) return;
    document.getElementById('productCode').value = prod.productCode || prod.productcode || '';
    document.getElementById('productName').value = prod.name || prod.productName || '';
    document.getElementById('productBarcode').value = prod.barcode || '';
    document.getElementById('productUnit').value = prod.unit || '';
    editingProductCode = code;
    switchTab('add');
    // หลังจากสลับไปแท็บเพิ่มสินค้าแล้ว ให้เลื่อนหน้าจอขึ้นบนสุดและโฟกัสที่ช่องรหัสสินค้า
    setTimeout(() => {
        try {
            window.scrollTo({ top: 0, behavior: 'smooth' });
            const codeInput = document.getElementById('productCode');
            if (codeInput) {
                codeInput.focus();
                codeInput.select();
            }
        } catch (e) {
            // fallback: focus ทันที
            const codeInput = document.getElementById('productCode');
            if (codeInput) codeInput.focus();
        }
    }, 100);
}

async function deleteProductByCode(code) {
    if (!code) return;
    if (!confirm('คุณแน่ใจหรือไม่ว่าต้องการลบสินค้านี้?')) return;
    try {
        const formData = new FormData();
        formData.append('action', 'delete');
        formData.append('productCode', code);
        const response = await fetch(GAS_URL, { method: 'POST', body: formData });
        const result = await response.json();
        if (result.status === 'deleted') {
            showStatus('addStatus', '✅ ลบสินค้าสำเร็จ', 'success');
            await loadAllProducts();
        } else {
            showStatus('addStatus', '❌ ไม่สามารถลบสินค้าได้', 'error');
        }
    } catch (error) {
        console.error('Error deleting product:', error);
        showStatus('addStatus', '❌ ไม่สามารถเชื่อมต่อได้', 'error');
    }
}

// ====== สแกนบาร์โค้ดด้วย html5-qrcode ======
// ====== สแกนบาร์โค้ดด้วย html5-qrcode ======
async function startScanning() {
    // ป้องกัน error ถ้าโหลดไลบรารีไม่ได้
    if (typeof Html5Qrcode === "undefined") {
        showStatus("scanStatus", "❌ ไม่สามารถโหลดไลบรารีสแกนบาร์โค้ดได้", "error");
        alert("โหลด html5-qrcode ไม่สำเร็จ (อาจถูกบล็อก หรือเน็ตหลุด)");
        return;
    }

    const startBtn = document.getElementById("startScanBtn");
    const stopBtn = document.getElementById("stopScanBtn");
    const switchBtn = document.getElementById("switchCameraBtn");
    const flashBtn = document.getElementById("flashToggleBtn");
    const scannerContainer = document.getElementById("scannerContainer");

    // ซ่อนปุ่มเริ่มและแสดงปุ่มหยุด + ตัวสแกน
    startBtn.style.display = "none";
    stopBtn.style.display = "inline-block";
    scannerContainer.style.display = "block";

    // รีเซ็ตสถานะแฟลช (ค่าเริ่มต้น: ปิดแฟลช และข้อความแสดงว่าปิด)
    if (flashBtn) {
        flashBtn.style.display = "none";
        flashBtn.textContent = "💡 เปิดแฟลช";
        isFlashOn = false;
    }

    // เริ่มระบบแนะนำระยะห่าง + ปรับความสูงตาราง
    startDistanceGuide();
    adjustScannedTableHeight();

    try {
        // ดึงรายการกล้องทั้งหมด
        const cameras = await Html5Qrcode.getCameras();

        // หากไม่มีอุปกรณ์กล้องเลย
        if (!cameras || cameras.length === 0) {
            showStatus("scanStatus", "❌ ไม่พบอุปกรณ์กล้องในเครื่องนี้", "error");
            startBtn.style.display = "inline-block";
            stopBtn.style.display = "none";
            scannerContainer.style.display = "none";
            if (switchBtn) switchBtn.style.display = "none";
            return;
        }

        // เก็บรายการกล้องทั้งหมด
        camerasList = cameras;

        // หา index กล้องหลังจาก label (รองรับคำว่า 'back', 'rear', 'environment', 'หลัง')
        let backIndex = camerasList.findIndex(cam => {
            const label = (cam.label || "").toLowerCase();
            return label.includes("back") ||
                   label.includes("rear") ||
                   label.includes("environment") ||
                   label.includes("หลัง");
        });

        // ถ้าไม่เจอจากชื่อเลย → ใช้ "กล้องตัวสุดท้าย" เป็น default (ส่วนใหญ่คือกล้องหลัง)
        if (backIndex < 0) {
            backIndex = camerasList.length - 1;
        }
        currentCameraIndex = backIndex;

        // ===== debug: แสดงรายการกล้องบน console + ในหน้าจอมือถือ =====
        const debugList = camerasList
            .map((cam, idx) => {
                const isCurrent = (idx === currentCameraIndex) ? "⭐" : " ";
                return `${isCurrent}[${idx}] ${cam.label || "(ไม่มีชื่อ)"}`;
            })
            .join(" | ");

        console.log("Camera list:", debugList);

        // แสดงให้เห็นบน mobile ผ่าน scanStatus
        showStatus(
            "scanStatus",
            `📷 ใช้กล้องตัวที่ ${currentCameraIndex + 1}/${camerasList.length}: ${camerasList[currentCameraIndex].label || "ไม่มีชื่อ (คาดว่าเป็นกล้องหลัง)"}`,
            "success"
        );
        // ============================

        // แสดงปุ่มสลับกล้องเมื่อมีกล้องมากกว่า 1 ตัว
        if (camerasList.length > 1 && switchBtn) {
            switchBtn.style.display = "inline-block";
        } else if (switchBtn) {
            switchBtn.style.display = "none";
        }

        // เริ่มสแกนด้วยกล้องที่เลือก
        const selectedDeviceId = camerasList[currentCameraIndex].id;
        await startQrWithCamera(selectedDeviceId);

    } catch (err) {
        console.error("Failed to start scanner", err);
        showStatus("scanStatus", "❌ ไม่สามารถเริ่มสแกนได้ (อาจไม่ได้ให้สิทธิ์กล้อง)", "error");

        startBtn.style.display = "inline-block";
        stopBtn.style.display = "none";
        scannerContainer.style.display = "none";
        if (switchBtn) switchBtn.style.display = "none";

        // ป้องกัน instance ค้าง
        if (html5QrCodeInstance) {
            try { await html5QrCodeInstance.stop(); } catch (e) {}
            try { await html5QrCodeInstance.clear(); } catch (e) {}
            html5QrCodeInstance = null;
        }
    }
}


async function startScanning_bck() {
    // ป้องกัน error ถ้าโหลดไลบรารีไม่ได้
    if (typeof Html5Qrcode === "undefined") {
        showStatus("scanStatus", "❌ ไม่สามารถโหลดไลบรารีสแกนบาร์โค้ดได้", "error");
        alert("โหลด html5-qrcode ไม่สำเร็จ (อาจถูกบล็อก หรือเน็ตหลุด)");
        return;
    }

    const startBtn = document.getElementById("startScanBtn");
    const stopBtn = document.getElementById("stopScanBtn");
    const switchBtn = document.getElementById("switchCameraBtn");
    const flashBtn = document.getElementById("flashToggleBtn");
    const scannerContainer = document.getElementById("scannerContainer");

    // ซ่อนปุ่มเริ่มและแสดงปุ่มหยุด + ตัวสแกน
    startBtn.style.display = "none";
    stopBtn.style.display = "inline-block";
    scannerContainer.style.display = "block";
    // ซ่อนปุ่มแฟลชตอนเริ่ม จะแสดงเมื่อเปิดกล้องสำเร็จและรองรับแฟลช
    if (flashBtn) {
        flashBtn.style.display = 'none';
        flashBtn.textContent = '💡 ปิดแฟลช';
        isFlashOn = false;
    }

    // แสดงข้อความแนะนำระยะห่างทันทีเมื่อแสดงกล้อง (ก่อนเริ่มสแกน)
    startDistanceGuide();

    // ปรับความสูงของตารางสินค้าให้เต็มพื้นที่หน้าจอ (หลังจากแสดงกล้อง)
    adjustScannedTableHeight();

    try {
        // ดึงรายการกล้องทั้งหมด
        const cameras = await Html5Qrcode.getCameras();
        // หากไม่มีอุปกรณ์กล้องเลย
        if (!cameras || cameras.length === 0) {
            showStatus("scanStatus", "❌ ไม่พบอุปกรณ์กล้องในเครื่องนี้", "error");
            startBtn.style.display = "inline-block";
            stopBtn.style.display = "none";
            scannerContainer.style.display = "none";
            return;
        }

        // เก็บรายการกล้องและกรองเฉพาะกล้องที่เป็นด้านหลัง/สภาพแวดล้อม
        // เพื่อไม่ให้ใช้กล้องหน้าโดยไม่ได้ตั้งใจ
        let backCams = cameras.filter(cam => /back|rear|environment/i.test(cam.label));
        camerasList = backCams.length > 0 ? backCams : cameras;
        // ตั้งกล้องตัวแรกเป็นค่าเริ่มต้น (ซึ่งควรเป็นกล้องหลังถ้ามี)
        currentCameraIndex = 0;

        // แสดงปุ่มสลับกล้องเมื่อมีกล้องมากกว่า 1 ตัว
        if (camerasList.length > 1) {
            switchBtn.style.display = "inline-block";
        } else {
            switchBtn.style.display = "none";
        }

        // เริ่มสแกนด้วยกล้องที่เลือก
        const selectedDeviceId = camerasList[currentCameraIndex].id;
        await startQrWithCamera(selectedDeviceId);

    } catch (err) {
        console.error("Failed to start scanner", err);
        showStatus("scanStatus", "❌ ไม่สามารถเริ่มสแกนได้ (อาจไม่ได้ให้สิทธิ์กล้อง)", "error");

        startBtn.style.display = "inline-block";
        stopBtn.style.display = "none";
        scannerContainer.style.display = "none";
        switchBtn.style.display = "none";

        // ป้องกัน instance ค้าง
        if (html5QrCodeInstance) {
            try { await html5QrCodeInstance.stop(); } catch (e) { }
            try { html5QrCodeInstance.clear(); } catch (e) { }
            html5QrCodeInstance = null;
        }
    }
}


async function stopScanning() {
    const startBtn = document.getElementById("startScanBtn");
    const stopBtn = document.getElementById("stopScanBtn");
    const scannerContainer = document.getElementById("scannerContainer");
    const switchBtn = document.getElementById("switchCameraBtn");
    const flashBtn = document.getElementById("flashToggleBtn");

    // ถ้ายังไม่เคย start ไม่ต้องทำอะไร
    if (!html5QrCodeInstance) {
        startBtn.style.display = "inline-block";
        stopBtn.style.display = "none";
        scannerContainer.style.display = "none";
        if (switchBtn) switchBtn.style.display = "none";
        return;
    }

    try {
        await html5QrCodeInstance.stop();
        html5QrCodeInstance.clear();
    } catch (err) {
        console.warn("Scanner already stopped:", err);
    }

    html5QrCodeInstance = null;

    startBtn.style.display = "inline-block";
    stopBtn.style.display = "none";
    scannerContainer.style.display = "none";
    if (switchBtn) switchBtn.style.display = "none";
    // ซ่อนปุ่มแฟลชเมื่อหยุดสแกน
    if (flashBtn) flashBtn.style.display = "none";
    // ซ่อน overlay loading
    showFocusLoading(false);
    // หยุดคำแนะนำระยะห่าง
    stopDistanceGuide();

    // ปรับความสูงของตารางสแกนหลังจากซ่อนกล้อง
    adjustScannedTableHeight();
}


// ====== UI ทั่วไป ======
function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

    if (tab === 'add') {
        document.querySelector('.tab-btn:first-child').classList.add('active');
        document.getElementById('tab-add').classList.add('active');
        stopScanning();
    } else {
        document.querySelector('.tab-btn:last-child').classList.add('active');
        document.getElementById('tab-scan').classList.add('active');
        // ไม่ต้องโฟกัสช่องบาร์โค้ดอัตโนมัติเมื่อสลับไปแท็บสแกน
    }
}

// ค้นหาสินค้าจาก Barcode ผ่าน Apps Script
async function findProductByBarcode(barcode) {
    // ก่อนอื่นค้นหาในข้อมูลที่ cache ไว้ก่อนเพื่อลดการเรียกไปยัง Google Sheets ซึ่งอาจทำให้ช้า
    if (Array.isArray(productsCache) && productsCache.length > 0) {
        const local = productsCache.find(p => {
            const b = p.barcode || p.barCode || '';
            return String(b) === String(barcode);
        });
        if (local) {
            return local;
        }
    }
    // หากไม่พบใน cache ให้ไปค้นหาจาก Apps Script
    try {
        const response = await fetch(`${GAS_URL}?action=getByBarcode&barcode=${encodeURIComponent(barcode)}`);
        const data = await response.json();
        if (data && data.found && data.product) {
            // เมื่อดึงข้อมูลมาแล้ว ให้เพิ่มเข้า productsCache หากยังไม่มี เพื่อใช้ในครั้งถัดไป
            const existing = productsCache.find(p => {
                const b = p.barcode || p.barCode || '';
                return String(b) === String(data.product.barcode || data.product.barCode || '');
            });
            if (!existing) {
                productsCache.push(data.product);
                // หลังเพิ่มสินค้าลง cache ให้รีเฟรชตาราง เพื่อให้รายการอัปเดตโดยไม่ต้องโหลดใหม่ทั้งก้อน
                renderProductTable();
            }
            return data.product;
        }
        return null;
    } catch (error) {
        console.error('Error finding product:', error);
        return null;
    }
}

// บันทึกสินค้าใหม่/แก้ไขสินค้า
async function saveProduct() {
    const productCode = document.getElementById('productCode').value.trim();
    const name = document.getElementById('productName').value.trim();
    const barcode = document.getElementById('productBarcode').value.trim();
    const unit = document.getElementById('productUnit').value.trim();

    if (!productCode || !name || !barcode || !unit) {
        showStatus('addStatus', 'กรุณากรอกข้อมูลให้ครบถ้วน', 'error');
        return;
    }

    try {
        const formData = new FormData();
        formData.append('action', 'save');
        formData.append('productCode', productCode);
        formData.append('name', name);
        formData.append('barcode', barcode);
        formData.append('unit', unit);

        const response = await fetch(GAS_URL, {
            method: 'POST',
            body: formData
        });

        const result = await response.json();

        if (result.status === 'inserted' || result.status === 'updated') {
            showStatus('addStatus', '✅ บันทึกสินค้าเรียบร้อยแล้ว', 'success');
            document.getElementById('productCode').value = '';
            document.getElementById('productName').value = '';
            document.getElementById('productBarcode').value = '';
            document.getElementById('productUnit').value = '';
            editingProductCode = null;
            await loadAllProducts();
        } else {
            showStatus('addStatus', '❌ เกิดข้อผิดพลาดในการบันทึก', 'error');
        }
    } catch (error) {
        console.error('Error saving product:', error);
        showStatus('addStatus', '❌ ไม่สามารถเชื่อมต่อได้', 'error');
    }
}

function showStatus(elementId, message, type) {
    const statusDiv = document.getElementById(elementId);
    statusDiv.className = `status ${type}`;
    statusDiv.textContent = message;
    statusDiv.style.display = 'block';
    setTimeout(() => { statusDiv.style.display = 'none'; }, 3000);
}

// กด Enter ในช่องพิมพ์บาร์โค้ด
document.getElementById('barcodeInput').addEventListener('keypress', async function (e) {
    if (e.key === 'Enter') {
        const barcode = this.value.trim();
        if (!barcode) return;

        const product = await findProductByBarcode(barcode);
        if (product) {
            addToTable(product);
            showStatus('scanStatus', `✅ พบสินค้า: ${product.name}`, 'success');
        } else {
            showStatus('scanStatus', `❌ ไม่พบสินค้า Barcode: ${barcode}`, 'error');
        }

        this.value = '';
    }
});

// เพิ่มสินค้าในตารางสแกน
function addToTable(product) {
    const tbody = document.getElementById('scannedBody');
    const existingRow = document.querySelector(`tr[data-barcode="${product.barcode}"]`);

    if (existingRow) {
        const qtyInput = existingRow.querySelector('.qty-input');
        qtyInput.focus();
        qtyInput.select();
        return;
    }

    if (tbody.querySelector('td[colspan="4"]')) {
        tbody.innerHTML = '';
    }

    const row = document.createElement('tr');
    row.setAttribute('data-barcode', product.barcode);
    row.innerHTML = `
                <td>${product.productCode}</td>
                <td>${product.name}</td>
                <td>${product.unit}</td>
                <td>
                    <input type="number" class="qty-input" value="0" min="0" 
                           data-barcode="${product.barcode}">
                </td>
            `;

    tbody.appendChild(row);
    saveToLocalStorage();

    setTimeout(() => {
        const qtyInput = row.querySelector('.qty-input');
        qtyInput.focus();
        qtyInput.select();
    }, 100);

    // ปรับความสูงของตารางสแกนเมื่อเพิ่มข้อมูลใหม่ เพื่อให้การเลื่อนอยู่ภายในตาราง
    adjustScannedTableHeight();
}

function saveToLocalStorage() {
    const rows = document.querySelectorAll('#scannedBody tr');
    const data = [];
    rows.forEach(row => {
        if (row.querySelector('td[colspan]')) return;
        const cells = row.querySelectorAll('td');
        const qtyInput = row.querySelector('.qty-input');
        data.push({
            productCode: cells[0].textContent,
            name: cells[1].textContent,
            unit: cells[2].textContent,
            quantity: qtyInput.value,
            barcode: row.getAttribute('data-barcode')
        });
    });
    localStorage.setItem('scannedProducts', JSON.stringify(data));
}

function loadFromLocalStorage() {
    const data = localStorage.getItem('scannedProducts');
    if (!data) return;
    const products = JSON.parse(data);
    const tbody = document.getElementById('scannedBody');
    tbody.innerHTML = '';
    products.forEach(product => {
        const row = document.createElement('tr');
        row.setAttribute('data-barcode', product.barcode);
        row.innerHTML = `
                    <td>${product.productCode}</td>
                    <td>${product.name}</td>
                    <td>${product.unit}</td>
                    <td>
                        <input type="number" class="qty-input" value="${product.quantity}" min="0" 
                               data-barcode="${product.barcode}">
                    </td>
                `;
        tbody.appendChild(row);
    });
}

// ==== Export สินค้าที่สแกน ออก Excel + Merge + Logo + รองรับ Mobile Files App ====

async function exportToExcel() {
    const rows = document.querySelectorAll('#scannedBody tr');
    // ไม่มีข้อมูล หรือเป็นแถว placeholder (colspan=4/5)
    if (rows.length === 0 || rows[0].querySelector('td[colspan]')) {
        alert('ไม่มีข้อมูลสำหรับ Export');
        return;
    }

    if (typeof ExcelJS === 'undefined') {
        alert('ไม่พบ ExcelJS (ตรวจ script src exceljs ใน index.html)');
        return;
    }

    // ==== 1) เตรียมวันที่/เวลาไทย ====
    const now = new Date();
    const monthsTh = [
        'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
        'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'
    ];
    const day = now.getDate();
    const monthName = monthsTh[now.getMonth()];
    const yearTh = now.getFullYear() + 543;

    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');

    const titleLine = 'รายงานสินค้าคงเหลือ';
    const monthLine = `เดือน ${monthName} ${yearTh}`;
    const timeLine  = `เวลา ${hh}:${mm}:${ss}`;

    // ==== 2) สร้าง Workbook / Worksheet ====
    const workbook  = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('สินค้าคงเหลือ');

    // ตั้งความกว้างคอลัมน์
    worksheet.columns = [
        { header: 'ลำดับ',        key: 'index', width: 8  },
        { header: 'รหัสสินค้า',    key: 'code',  width: 16 },
        { header: 'รายการ',        key: 'name',  width: 42 },
        { header: 'หน่วยนับ',      key: 'unit',  width: 14 },
        { header: 'จำนวนคงเหลือ',  key: 'qty',   width: 16 },
    ];

    // ==== 3) Header แถว 1–3 + Merge A1:E3 ====
    worksheet.mergeCells('A1:E1');
    const row1 = worksheet.getCell('A1');
    row1.value = titleLine;
    row1.alignment = { horizontal: 'center', vertical: 'middle' };
    row1.font = { bold: true, size: 18, color: { argb: 'FF000000' } };

    worksheet.mergeCells('A2:E2');
    const row2 = worksheet.getCell('A2');
    row2.value = monthLine;
    row2.alignment = { horizontal: 'center', vertical: 'middle' };
    row2.font = { bold: false, size: 13, color: { argb: 'FF000000' } };

    worksheet.mergeCells('A3:E3');
    const row3 = worksheet.getCell('A3');
    row3.value = timeLine;
    row3.alignment = { horizontal: 'center', vertical: 'middle' };
    row3.font = { bold: false, size: 11, color: { argb: 'FF000000' } };

    worksheet.getRow(1).height = 26;
    worksheet.getRow(2).height = 20;
    worksheet.getRow(3).height = 18;

    // เส้นบางใต้หัวใหญ่
    worksheet.getRow(4).border = {
        bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } }
    };

    // ==== 4) ใส่ LOGO มุมบนซ้าย เป็นสี่เหลี่ยมจัตุรัส ====
    try {
        const logoBase64 = await getLogoBase64(); // data:image/png;base64,...
        if (logoBase64) {
            const imageId = workbook.addImage({
                base64: logoBase64,
                extension: 'png'
            });

            // แนะนำให้ไฟล์ logo.png เป็นรูปสี่เหลี่ยมจัตุรัสอยู่แล้ว
            worksheet.addImage(imageId, {
                tl:  { col: 0, row: 0 },        // เริ่มใกล้ A1
                ext: { width: 90, height: 90 }  // 90x90 เป็นสี่เหลี่ยมจัตุรัส
            });
        }
    } catch (e) {
        console.warn('ใส่โลโก้ใน Excel ไม่ได้ แต่จะสร้างไฟล์ต่อ', e);
    }

    // ==== 5) หัวคอลัมน์ของตาราง (Row 5) ====
    const headerRowIndex = 5;
    const headerRow = worksheet.getRow(headerRowIndex);
    headerRow.values = ['ลำดับ', 'รหัสสินค้า', 'รายการ', 'หน่วยนับ', 'จำนวนคงเหลือ'];

    headerRow.eachCell((cell, colNumber) => {
        // alignment
        if (colNumber === 1 || colNumber === 4) {
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
        } else if (colNumber === 5) {
            cell.alignment = { horizontal: 'right', vertical: 'middle' };
        } else {
            cell.alignment = { horizontal: 'left', vertical: 'middle' };
        }

        cell.font = { bold: true, color: { argb: 'FF000000' } };

        // border หัวตารางใช้สีดำ
        cell.border = {
            top:    { style: 'thin', color: { argb: 'FF000000' } },
            left:   { style: 'thin', color: { argb: 'FF000000' } },
            bottom: { style: 'thin', color: { argb: 'FF000000' } },
            right:  { style: 'thin', color: { argb: 'FF000000' } }
        };

        // สีส้มอ่อน ๆ หัวคอลัมน์
        cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFFE4C4' } // ส้มอ่อนแนวครีม
        };
    });
    worksheet.getRow(headerRowIndex).height = 22;

    // ==== 6) ใส่ข้อมูลจากตารางสแกน ====
    let excelRowIndex = headerRowIndex + 1;
    let runningIndex  = 1;

    rows.forEach(row => {
        if (row.querySelector('td[colspan]')) return; // ข้าม placeholder

        const cells    = row.querySelectorAll('td');
        const qtyInput = row.querySelector('.qty-input');

        const productCode = cells[0] ? cells[0].textContent.trim() : '';
        const name        = cells[1] ? cells[1].textContent.trim() : '';
        const unit        = cells[2] ? cells[2].textContent.trim() : '';
        const qtyRaw      = qtyInput ? qtyInput.value.trim() : '';
        let qty = null;

        if (qtyRaw !== '') {
            const parsed = Number(qtyRaw.replace(',', ''));
            qty = isNaN(parsed) ? null : parsed;
        }

        const excelRow = worksheet.getRow(excelRowIndex++);

        excelRow.getCell(1).value = runningIndex;
        excelRow.getCell(2).value = productCode;
        excelRow.getCell(3).value = name;
        excelRow.getCell(4).value = unit;
        excelRow.getCell(5).value = qty;

        excelRow.eachCell((cell, colNumber) => {
            // alignment ตามคอลัมน์
            if (colNumber === 1 || colNumber === 4) {
                cell.alignment = { horizontal: 'center', vertical: 'middle' };
            } else if (colNumber === 5) {
                cell.alignment = { horizontal: 'right', vertical: 'middle' };
            } else {
                cell.alignment = { horizontal: 'left', vertical: 'middle' };
            }

            // font สีดำ
            cell.font = { color: { argb: 'FF000000' } };

            // border ชุดข้อมูล → ใช้สีดำทั้งหมด
            cell.border = {
                top:    { style: 'thin', color: { argb: 'FF000000' } },
                left:   { style: 'thin', color: { argb: 'FF000000' } },
                bottom: { style: 'thin', color: { argb: 'FF000000' } },
                right:  { style: 'thin', color: { argb: 'FF000000' } }
            };

            // แถวสลับสีให้อ่านง่าย (พื้นหลังอ่อน ๆ)
            if (runningIndex % 2 === 0) {
                cell.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFFFFAF0' } // ส้มครีมอ่อน
                };
            }
        });

        // รูปแบบตัวเลข "จำนวนคงเหลือ"
        const qtyCell = excelRow.getCell(5);
        if (qty !== null) {
            if (Number.isInteger(qty)) {
                // ถ้าเป็นจำนวนเต็ม → ไม่มีทศนิยมเลย
                qtyCell.numFmt = '#,##0';
            } else {
                // ถ้ามีทศนิยม → แสดงได้สูงสุด 2 ตำแหน่ง
                qtyCell.numFmt = '#,##0.##';
            }
        }

        excelRow.height = 18;
        runningIndex++;
    });

    // ==== 7) สร้างไฟล์ + รองรับ SHARE (iOS / Android) + Fallback เหมือนเดิม ====
    try {
        const buffer = await workbook.xlsx.writeBuffer();

        const blob = new Blob(
            [buffer],
            { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
        );

        const fileName = `รายงานสินค้าคงเหลือ_${now.getFullYear()}${String(now.getMonth()+1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}.xlsx`;

        // สร้าง File สำหรับใช้กับ Web Share API (ถ้ารองรับ)
        const file = new File(
            [blob],
            fileName,
            { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
        );

        // ---- 7.1 พยายามใช้ Web Share API ก่อน (iOS / Android รุ่นใหม่) ----
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            try {
                await navigator.share({
                    title: 'รายงานสินค้าคงเหลือ',
                    text: 'ไฟล์รายงาน Excel',
                    files: [file]
                });
                // แชร์สำเร็จแล้ว จบเลย
                return;
            } catch (shareErr) {
                console.warn('แชร์ไฟล์ไม่สำเร็จ ใช้ fallback download/open ต่อ', shareErr);
                // ถ้า user กด cancel หรือ error อื่น ๆ → ไป fallback ด้านล่าง
            }
        }

        // ---- 7.2 Fallback แบบเดิม: iOS เปิดแท็บใหม่ให้ Save to Files, ที่เหลือดาวน์โหลด ----
        const url = URL.createObjectURL(blob);
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

        if (isIOS) {
            window.open(url, '_blank');
            alert(
                'ระบบสร้างไฟล์ Excel แล้ว\n' +
                '- ถ้าใช้ Safari: แตะปุ่มแชร์ แล้วเลือก "Save to Files" เพื่อบันทึกลงแอปไฟล์'
            );
        } else {
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }

        setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
        console.error('Export to Excel failed', err);
        alert('ไม่สามารถสร้างไฟล์ Excel ได้');
    }
}



async function exportToExcel_bck_css() {
    const rows = document.querySelectorAll('#scannedBody tr');
    // ไม่มีข้อมูล หรือเป็นแถว placeholder (colspan=4)
    if (rows.length === 0 || rows[0].querySelector('td[colspan]')) {
        alert('ไม่มีข้อมูลสำหรับ Export');
        return;
    }

    if (typeof ExcelJS === 'undefined') {
        alert('ไม่พบ ExcelJS (ตรวจ script src exceljs ใน index.html)');
        return;
    }

    // ==== 1) เตรียมวันที่/เวลาไทย ====
    const now = new Date();
    const monthsTh = [
        'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
        'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'
    ];
    const day = now.getDate();
    const monthName = monthsTh[now.getMonth()];
    const yearTh = now.getFullYear() + 543;

    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');

    const titleLine = 'รายงานสินค้าคงเหลือ';
    const monthLine = `เดือน ${monthName} ${yearTh}`;
    const timeLine  = `เวลา ${hh}:${mm}:${ss}`;

    // ==== 2) สร้าง Workbook / Worksheet ====
    const workbook  = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('สินค้าคงเหลือ');

    // ตั้งความกว้างคอลัมน์
    worksheet.columns = [
        { header: 'ลำดับ',        key: 'index', width: 8  },
        { header: 'รหัสสินค้า',    key: 'code',  width: 16 },
        { header: 'รายการ',        key: 'name',  width: 42 },
        { header: 'หน่วยนับ',      key: 'unit',  width: 14 },
        { header: 'จำนวนคงเหลือ',  key: 'qty',   width: 16 },
    ];

    // ==== 3) Header แถว 1–3 + Merge A1:E3 ====
    worksheet.mergeCells('A1:E1');
    const row1 = worksheet.getCell('A1');
    row1.value = titleLine;
    row1.alignment = { horizontal: 'center', vertical: 'middle' };
    row1.font = { bold: true, size: 18, color: { argb: 'FF000000' } };

    worksheet.mergeCells('A2:E2');
    const row2 = worksheet.getCell('A2');
    row2.value = monthLine;
    row2.alignment = { horizontal: 'center', vertical: 'middle' };
    row2.font = { bold: false, size: 13, color: { argb: 'FF000000' } };

    worksheet.mergeCells('A3:E3');
    const row3 = worksheet.getCell('A3');
    row3.value = timeLine;
    row3.alignment = { horizontal: 'center', vertical: 'middle' };
    row3.font = { bold: false, size: 11, color: { argb: 'FF000000' } };

    worksheet.getRow(1).height = 26;
    worksheet.getRow(2).height = 20;
    worksheet.getRow(3).height = 18;

    // เส้นบางใต้หัวใหญ่
    worksheet.getRow(4).border = {
        bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } }
    };

    // ==== 4) ใส่ LOGO มุมบนซ้าย เป็นสี่เหลี่ยมจัตุรัส ====
    try {
        const logoBase64 = await getLogoBase64(); // data:image/png;base64,...
        if (logoBase64) {
            const imageId = workbook.addImage({
                base64: logoBase64,
                extension: 'png'
            });

            // แนะนำให้ไฟล์ logo.png เป็นรูปสี่เหลี่ยมจัตุรัสอยู่แล้ว
            worksheet.addImage(imageId, {
                tl:  { col: 0, row: 0 },        // เริ่มใกล้ A1
                ext: { width: 90, height: 90 }  // 90x90 เป็นสี่เหลี่ยมจัตุรัส
            });
        }
    } catch (e) {
        console.warn('ใส่โลโก้ใน Excel ไม่ได้ แต่จะสร้างไฟล์ต่อ', e);
    }

    // ==== 5) หัวคอลัมน์ของตาราง (Row 5) ====
    const headerRowIndex = 5;
    const headerRow = worksheet.getRow(headerRowIndex);
    headerRow.values = ['ลำดับ', 'รหัสสินค้า', 'รายการ', 'หน่วยนับ', 'จำนวนคงเหลือ'];

    headerRow.eachCell((cell, colNumber) => {
        // alignment
        if (colNumber === 1 || colNumber === 4) {
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
        } else if (colNumber === 5) {
            cell.alignment = { horizontal: 'right', vertical: 'middle' };
        } else {
            cell.alignment = { horizontal: 'left', vertical: 'middle' };
        }

        cell.font = { bold: true, color: { argb: 'FF000000' } };

        // border หัวตารางใช้เทาอ่อน
        cell.border = {
            top:    { style: 'thin', color: { argb: 'FF000000' } },
            left:   { style: 'thin', color: { argb: 'FF000000' } },
            bottom: { style: 'thin', color: { argb: 'FF000000' } },
            right:  { style: 'thin', color: { argb: 'FF000000' } }
        };

        // สีส้มอ่อน ๆ หัวคอลัมน์
        cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFFE4C4' } // ส้มอ่อนแนวครีม
        };
    });
    worksheet.getRow(headerRowIndex).height = 22;

    // ==== 6) ใส่ข้อมูลจากตารางสแกน ====
    let excelRowIndex = headerRowIndex + 1;
    let runningIndex  = 1;

    rows.forEach(row => {
        if (row.querySelector('td[colspan]')) return; // ข้าม placeholder

        const cells    = row.querySelectorAll('td');
        const qtyInput = row.querySelector('.qty-input');

        const productCode = cells[0] ? cells[0].textContent.trim() : '';
        const name        = cells[1] ? cells[1].textContent.trim() : '';
        const unit        = cells[2] ? cells[2].textContent.trim() : '';
        const qtyRaw      = qtyInput ? qtyInput.value.trim() : '';
        let qty = null;

        if (qtyRaw !== '') {
            const parsed = Number(qtyRaw.replace(',', ''));
            qty = isNaN(parsed) ? null : parsed;
        }

        const excelRow = worksheet.getRow(excelRowIndex++);

        excelRow.getCell(1).value = runningIndex;
        excelRow.getCell(2).value = productCode;
        excelRow.getCell(3).value = name;
        excelRow.getCell(4).value = unit;
        excelRow.getCell(5).value = qty;

        excelRow.eachCell((cell, colNumber) => {
            // alignment ตามคอลัมน์
            if (colNumber === 1 || colNumber === 4) {
                cell.alignment = { horizontal: 'center', vertical: 'middle' };
            } else if (colNumber === 5) {
                cell.alignment = { horizontal: 'right', vertical: 'middle' };
            } else {
                cell.alignment = { horizontal: 'left', vertical: 'middle' };
            }

            // font สีดำ
            cell.font = { color: { argb: 'FF000000' } };

            // border ชุดข้อมูล → ใช้สีดำทั้งหมด
            cell.border = {
                top:    { style: 'thin', color: { argb: 'FF000000' } },
                left:   { style: 'thin', color: { argb: 'FF000000' } },
                bottom: { style: 'thin', color: { argb: 'FF000000' } },
                right:  { style: 'thin', color: { argb: 'FF000000' } }
            };

            // แถวสลับสีให้อ่านง่าย (พื้นหลังอ่อน ๆ)
            if (runningIndex % 2 === 0) {
                cell.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFFFFAF0' } // ส้มครีมอ่อน
                };
            }
        });

        // รูปแบบตัวเลข "จำนวนคงเหลือ"
        const qtyCell = excelRow.getCell(5);
        if (qty !== null) {
            if (Number.isInteger(qty)) {
                // ถ้าเป็นจำนวนเต็ม → ไม่มีทศนิยมเลย
                qtyCell.numFmt = '#,##0';
            } else {
                // ถ้ามีทศนิยม → แสดงได้สูงสุด 2 ตำแหน่ง
                qtyCell.numFmt = '#,##0.##';
            }
        }

        excelRow.height = 18;
        runningIndex++;
    });

    // ==== 7) สร้างไฟล์และ trigger download (รองรับ Mobile / Files App) ====
    try {
        const buffer = await workbook.xlsx.writeBuffer();

        const blob = new Blob(
            [buffer],
            { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
        );

        const url = URL.createObjectURL(blob);
        const fileName = `รายงานสินค้าคงเหลือ_${now.getFullYear()}${String(now.getMonth()+1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}.xlsx`;

        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

        if (isIOS) {
            window.open(url, '_blank');
            alert(
                'ระบบสร้างไฟล์ Excel แล้ว\n' +
                '- ถ้าใช้ Safari: แตะปุ่มแชร์ แล้วเลือก "Save to Files" เพื่อบันทึกลงแอปไฟล์'
            );
        } else {
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }

        setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
        console.error('Export to Excel failed', err);
        alert('ไม่สามารถสร้างไฟล์ Excel ได้');
    }
}




function exportToExcel_bck() {
    const rows = document.querySelectorAll('#scannedBody tr');
    if (rows.length === 0 || rows[0].querySelector('td[colspan]')) {
        alert('ไม่มีข้อมูลสำหรับ Export');
        return;
    }

    // เตรียมข้อมูลสำหรับ SheetJS (รวมหัวตาราง)
    const data = [];
    data.push(['รหัสสินค้า', 'ชื่อสินค้า', 'หน่วยนับ', 'จำนวนคงเหลือ', 'Barcode']);
    rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        const qtyInput = row.querySelector('.qty-input');
        const barcode = row.getAttribute('data-barcode');
        data.push([
            cells[0].textContent,
            cells[1].textContent,
            cells[2].textContent,
            qtyInput.value,
            barcode
        ]);
    });

    try {
        // ตรวจสอบว่า SheetJS ถูกโหลดแล้วหรือไม่
        if (typeof XLSX !== 'undefined' && XLSX && XLSX.utils) {
            const worksheet = XLSX.utils.aoa_to_sheet(data);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, 'Products');
            const filename = `สินค้าคงเหลือ_${new Date().toISOString().split('T')[0]}.xlsx`;
            XLSX.writeFile(workbook, filename);
        } else {
            throw new Error('SheetJS library is not available');
        }
    } catch (err) {
        console.error('Export to Excel failed', err);
        alert('ไม่สามารถสร้างไฟล์ Excel ได้');
    }
}

function confirmClearData() {
    document.getElementById('confirmModal').classList.add('active');
}

function closeModal() {
    document.getElementById('confirmModal').classList.remove('active');
}

function clearAllData() {
    localStorage.removeItem('scannedProducts');
    const tbody = document.getElementById('scannedBody');
    tbody.innerHTML = `
                <tr>
                    <td colspan="4" style="text-align: center; color: #9ca3af; padding: 30px;">
                        ยังไม่มีรายการสินค้า<br>กรุณาสแกนบาร์โค้ด
                    </td>
                </tr>
            `;
    closeModal();
    showStatus('scanStatus', '✅ ล้างข้อมูลเรียบร้อยแล้ว', 'success');
}

// ====== Modal แจ้งเตือนเมื่อไม่พบสินค้า ======
function showNotFoundModal(barcode) {
    const modal = document.getElementById('notFoundModal');
    if (!modal) return;
    // เก็บ barcode ไว้ใน dataset เพื่อใช้ตอนเพิ่มสินค้า
    modal.dataset.barcode = barcode || '';
    modal.classList.add('active');
}

function closeNotFoundModal() {
    const modal = document.getElementById('notFoundModal');
    if (modal) {
        modal.classList.remove('active');
        modal.dataset.barcode = '';
    }
}

function openAddTabFromModal() {
    const modal = document.getElementById('notFoundModal');
    const barcode = modal ? modal.dataset.barcode : '';
    closeNotFoundModal();
    // สลับไปยังแท็บเพิ่มสินค้า
    switchTab('add');
    // เติมเลข barcode ในแบบฟอร์มเพื่อความสะดวก
    if (barcode) {
        document.getElementById('productBarcode').value = barcode;
    }
    // โฟกัสที่ช่องรหัสสินค้าเพื่อให้ผู้ใช้เริ่มกรอกข้อมูลได้ทันที
    document.getElementById('productCode').focus();
}

document.addEventListener('input', function (e) {
    if (e.target.classList.contains('qty-input')) {
        saveToLocalStorage();
    }
});

window.addEventListener('load', function () {
    loadFromLocalStorage();
    loadAllProducts();
    // ปรับความสูงของตารางสแกนเมื่อโหลดหน้าเสร็จ
    adjustScannedTableHeight();

    // ตั้งค่า event ค้นหาสินค้า: เมื่อผู้ใช้พิมพ์ในช่องค้นหา ให้กรองรายการสินค้าและรีเซ็ตไปหน้าที่ 1
    const searchInputEl = document.getElementById('productSearchInput');
    if (searchInputEl) {
        searchInputEl.addEventListener('input', function () {
            productSearchQuery = this.value.toLowerCase();
            currentProductPage = 1;
            renderProductTable();
        });
    }
});

// ปรับความสูงของตารางสแกนเมื่อปรับขนาดหน้าต่าง (เช่น หมุนจอมือถือ)
window.addEventListener('resize', adjustScannedTableHeight);