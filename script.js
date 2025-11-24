const GAS_URL = 
    'https://script.google.com/macros/s/AKfycbwDzGixiLj0AwYLdCitPc0z4laVb8EEh_aQdBbbpyFkcGVdGrmZD2NRq6Mn5GJcchJG/exec';

let productsCache = [];
let editingProductCode = null;
let html5QrCodeInstance = null;

// เก็บรายการกล้องทั้งหมด และ index ของกล้องที่ใช้งานอยู่
let camerasList = [];
let currentCameraIndex = 0;

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

// ฟังก์ชันสำหรับเริ่มสแกนด้วยกล้องตาม id ที่กำหนด
async function startQrWithCamera(selectedDeviceId) {
    if (!html5QrCodeInstance) {
        html5QrCodeInstance = new Html5Qrcode("scanner");
    }
    const config = {
        fps: 20,
        qrbox: { width: 300, height: 300 },
        useBarCodeDetectorIfSupported: true,
        // เพิ่ม videoConstraints เพื่อขอ resolution ที่สูงขึ้น
        videoConstraints: {
            deviceId: { exact: selectedDeviceId },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            // หาก browser รองรับ continuous focus
            focusMode: "continuous"
        },
        formatsToSupport: [
            Html5QrcodeSupportedFormats.QR_CODE,
            Html5QrcodeSupportedFormats.CODE_128,
            Html5QrcodeSupportedFormats.CODE_39,
            Html5QrcodeSupportedFormats.EAN_13,
            Html5QrcodeSupportedFormats.EAN_8,
            Html5QrcodeSupportedFormats.UPC_A
        ]
    };
    // เริ่มสแกนด้วย config ที่กำหนดไว้
    await html5QrCodeInstance.start(
        { deviceId: { exact: selectedDeviceId } },
        config,
        async (decodedText) => {
            const product = await findProductByBarcode(decodedText);
            if (product) {
                addToTable(product);
                showStatus("scanStatus", `✅ พบสินค้า: ${product.name}`, "success");
            } else {
                showStatus("scanStatus", `❌ ไม่พบสินค้า Barcode: ${decodedText}`, "error");
            }
        },
        (err) => {
            // ไม่ต้องแสดง error ตอนสแกนแต่ละ frame
        }
    );
    // หลังเริ่มสแกนแล้ว ลองปรับการโฟกัสและซูม (ถ้าเบราว์เซอร์รองรับ)
    try {
        if (typeof html5QrCodeInstance.applyVideoConstraints === 'function') {
            // หน่วงเวลาเล็กน้อยให้สตรีมทำงานก่อนค่อยตั้งค่า
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
    if (!productsCache || productsCache.length === 0) {
        // ไม่มีสินค้าจากฐานข้อมูล ให้แสดงข้อความครอบคลุม 6 คอลัมน์ (รวมคอลัมน์แก้ไข/ลบ)
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #9ca3af; padding: 20px;">ไม่มีข้อมูลสินค้า</td></tr>`;
        return;
    }
    productsCache.forEach(prod => {
        const code = prod.productCode || prod.productcode || '';
        const name = prod.name || prod.productName || '';
        const barcode = prod.barcode || '';
        const unit = prod.unit || '';
        const tr = document.createElement('tr');
        /*
            ปรับโครงสร้างตารางให้มีคอลัมน์แยกสำหรับปุ่มแก้ไขและลบ โดยเพิ่มเซลล์ใหม่สองตำแหน่ง
            แทนที่จะรวมปุ่มทั้งสองไว้ในคอลัมน์เดียว ซึ่งช่วยให้ตารางสอดคล้องกับส่วนหัวที่มี 6 คอลัมน์
        */
        tr.innerHTML = `
                    <td>${code}</td>
                    <td>${name}</td>
                    <td>${barcode}</td>
                    <td>${unit}</td>
                    <td>
                        <button class="btn btn-secondary btn-sm" onclick="editProduct('${code}')">แก้ไข</button>
                    </td>
                    <td>
                        <button class="btn btn-danger btn-sm" onclick="deleteProductByCode('${code}')">ลบ</button>
                    </td>
                `;
        tbody.appendChild(tr);
    });
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
    const scannerContainer = document.getElementById("scannerContainer");

    // ซ่อนปุ่มเริ่มและแสดงปุ่มหยุด + ตัวสแกน
    startBtn.style.display = "none";
    stopBtn.style.display = "inline-block";
    scannerContainer.style.display = "block";

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

        // เก็บรายการกล้องและค้นหากล้องหลังเป็นค่าเริ่มต้น
        camerasList = cameras;
        // ค้นหากล้องที่ชื่อสื่อถึง environment/back
        const backIndex = camerasList.findIndex(cam => /back|rear|environment/i.test(cam.label));
        currentCameraIndex = backIndex >= 0 ? backIndex : 0;

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
        document.getElementById('barcodeInput').focus();
    }
}

// ค้นหาสินค้าจาก Barcode ผ่าน Apps Script
async function findProductByBarcode(barcode) {
    try {
        const response = await fetch(`${GAS_URL}?action=getByBarcode&barcode=${encodeURIComponent(barcode)}`);
        const data = await response.json();
        if (data.found) return data.product;
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

function exportToExcel() {
    const rows = document.querySelectorAll('#scannedBody tr');
    if (rows.length === 0 || rows[0].querySelector('td[colspan]')) {
        alert('ไม่มีข้อมูลสำหรับ Export');
        return;
    }

    let csv = 'รหัสสินค้า,ชื่อสินค้า,หน่วยนับ,จำนวนคงเหลือ,Barcode\n';
    rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        const qtyInput = row.querySelector('.qty-input');
        const barcode = row.getAttribute('data-barcode');
        csv += `"${cells[0].textContent}","${cells[1].textContent}","${cells[2].textContent}",${qtyInput.value},"${barcode}"\n`;
    });

    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `สินค้าคงเหลือ_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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

document.addEventListener('input', function (e) {
    if (e.target.classList.contains('qty-input')) {
        saveToLocalStorage();
    }
});

window.addEventListener('load', function () {
    loadFromLocalStorage();
    loadAllProducts();
});