// Các helper dùng chung cho DOM / UI — không phụ thuộc Firebase hay 1 màn
// hình cụ thể nào, nên đặt riêng để mọi module (kể cả state.js/data.js) đều
// import được mà không lo phụ thuộc vòng (circular import).
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const viewRoot = $("#view-root");

let toastTimer = null;
export function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// Xử lý lỗi dùng chung cho các thao tác người dùng chủ động bấm (lưu, xoá,
// cập nhật, gửi email...): LUÔN log ra console để debug, và LUÔN báo cho
// người dùng bằng 1 câu dễ hiểu qua toast — trước đây một số chỗ chỉ
// console.error mà không báo gì cả, khiến người dùng bấm xong không biết
// là đã lưu/xoá thành công hay chưa (nhìn màn hình vẫn y như cũ, im lặng).
// Không dùng hàm này cho lỗi khi TẢI dữ liệu 1 màn hình/danh sách — những
// chỗ đó đã có cách báo lỗi riêng, rõ ràng hơn: thay hẳn nội dung khu vực
// đang tải bằng 1 dòng "Không tải được..." ngay tại chỗ.
export function reportError(err, userMessage) {
  console.error(err);
  toast(userMessage || "Đã có lỗi xảy ra, thử lại nhé.");
}

// true nếu 1 trong các field của row (đọc từ fields, vd ["itemName","ghiChu"])
// chứa chuỗi tìm kiếm (không phân biệt hoa/thường, không dấu-sensitive).
export function emptyState(msg) {
  return `<div class="empty-state">
    <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 3h14l-1 6a6 6 0 0 1-12 0L5 3Z"/><path d="M9 21h6M12 15v6"/></svg>
    <div>${msg}</div>
  </div>`;
}

export function mount(id) {
  const tpl = $("#tpl-" + id);
  viewRoot.innerHTML = "";
  viewRoot.appendChild(tpl.content.cloneNode(true));
}

/* ===================== ẢNH HOÁ ĐƠN ===================== */
// Không dùng Firebase Storage (từ 09/2024 Storage mặc định yêu cầu gói Blaze
// trả phí) — thay vào đó nén ảnh nhỏ lại rồi lưu thẳng dạng base64 trong
// document Firestore (đủ nhỏ để không vượt giới hạn 1MB/document).
export function compressImageToDataUrl(file, maxDim = 900, quality = 0.6) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Không đọc được ảnh"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Không đọc được ảnh"));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const ratio = Math.min(maxDim / width, maxDim / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Gắn 1 input[type=file] ảnh hoá đơn vào 1 form: nén ảnh khi chọn, hiện
// preview nhỏ, cho xoá. Trả về { get, set } để form đọc/đặt giá trị hiện tại.
export function wireReceiptInput(inputId, rowId, imgId, clearBtnId) {
  const inputEl = $("#" + inputId);
  const rowEl = $("#" + rowId);
  const imgEl = $("#" + imgId);
  const clearBtn = $("#" + clearBtnId);
  if (!inputEl) return { get: () => "", set: () => {} };
  let current = "";
  function render() {
    if (current) { imgEl.src = current; rowEl.hidden = false; } else { rowEl.hidden = true; imgEl.src = ""; }
  }
  inputEl.addEventListener("change", async () => {
    const file = inputEl.files && inputEl.files[0];
    inputEl.value = "";
    if (!file) return;
    try {
      current = await compressImageToDataUrl(file);
      render();
    } catch (err) {
      reportError(err, "Không đọc được ảnh, thử ảnh khác nhé");
    }
  });
  clearBtn?.addEventListener("click", () => { current = ""; render(); });
  return { get: () => current, set: (url) => { current = url || ""; render(); } };
}

export function receiptThumbHtml(url) {
  return url ? `<img class="receipt-thumb" src="${url}" data-lightbox="1" alt="Ảnh hoá đơn" />` : "";
}

export function openLightbox(src) {
  const el = document.createElement("div");
  el.className = "receipt-lightbox";
  el.innerHTML = `<img src="${src}" alt="Ảnh hoá đơn" />`;
  el.addEventListener("click", () => el.remove());
  document.body.appendChild(el);
}

// Event delegation cho việc bấm mở to ảnh hoá đơn — dùng chung cho MỌI card
// có ảnh hoá đơn (nhập nguyên liệu, thu chi...) ở bất kỳ màn hình nào, nên
// đặt ở đây thay vì lặp lại/tách theo từng màn hình. viewRoot tồn tại xuyên
// suốt các lần render (mount() chỉ thay nội dung bên trong nó).
viewRoot.addEventListener("click", (e) => {
  const thumbEl = e.target.closest(".receipt-thumb");
  if (thumbEl) openLightbox(thumbEl.src);
});
