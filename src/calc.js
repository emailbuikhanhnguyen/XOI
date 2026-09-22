// ============================================================
// Các hàm tính toán/định dạng THUẦN TUÝ (pure) — không đụng tới DOM,
// Firebase, hay biến trạng thái toàn cục nào của app.js. Tách riêng ra
// đây để test được bằng Vitest mà không cần mock trình duyệt/Firebase.
//
// Đây là bước tách đầu tiên (phần nền tảng cho việc module hoá toàn bộ
// app.js sau này) — chỉ gồm những hàm rõ ràng thuần tuý, chưa động vào
// phần logic còn gắn với DOM/Firebase.
// ============================================================

export function fmt(n) {
  return Math.round(n || 0).toLocaleString("vi-VN") + "đ";
}

export function fmtNum(n) {
  return (n || 0).toLocaleString("vi-VN");
}

// Chuẩn hoá đơn vị (kg/lít/cái...) để gộp tồn kho đúng: đơn vị giờ là ô gõ tự
// do nên rất dễ gõ khác hoa/thường hoặc dư khoảng trắng (vd "Lít" và "lít")
// — nếu không chuẩn hoá, 2 cách gõ này bị tính là 2 loại khác nhau, làm tồn
// kho hiển thị sai (có dòng bị âm dù thực ra chỉ là gõ khác nhau). Áp dụng
// khi LƯU (để dữ liệu mới nhất quán) và khi TÍNH TỒN (để tự gộp lại đúng cả
// những bản ghi cũ đã lỡ gõ khác nhau, không cần sửa tay từng dòng).
export function normalizeUnit(u) {
  return (u || "").trim().toLowerCase();
}

export function isoLocal(d) {
  const y = d.getFullYear(),
    m = String(d.getMonth() + 1).padStart(2, "0"),
    day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayISO() {
  return isoLocal(new Date());
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return isoLocal(d);
}

export function mondayOf(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return isoLocal(d);
}

export const WEEKDAY = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

// Ngày nhập liệu (chấm công/nhập kho/chuyển hàng/thu chi) có nằm trong
// khoảng cho phép không: không được là ngày TƯƠNG LAI (so với `today`), và
// không được xa quá `pastDays` ngày trong quá khứ.
export function isDateInAllowedRange(dateStr, today = todayISO(), pastDays = 30) {
  if (!dateStr) return false;
  if (dateStr > today) return false;
  return dateStr >= addDays(today, -pastDays);
}

export function weekdayLabel(dateStr) {
  return WEEKDAY[new Date(dateStr + "T00:00:00").getDay()];
}

// Ước tính số lượng (soLuong) nên chuẩn bị cho 1 điểm bán vào ngày `dateStr`:
// trung bình soLuong của các phiếu chấm công KHÔNG nghỉ, cùng ngày trong
// tuần (cùng Thứ) với `dateStr`, trong `lookbackDays` ngày TRƯỚC đó (không
// tính chính ngày `dateStr`). `entriesForLocation` phải là các phiếu ĐÃ lọc
// sẵn theo đúng 1 điểm bán (hàm này không tự lọc locationId). Trả về null
// nếu chưa có phiếu nào cùng Thứ trong khoảng đã xét — cố tình KHÔNG suy đoán
// liều lĩnh (vd trả về 0) khi chưa có đủ dữ liệu lịch sử.
export function suggestedQtyForWeekday(entriesForLocation, dateStr, lookbackDays = 28) {
  const label = weekdayLabel(dateStr);
  const cutoff = addDays(dateStr, -lookbackDays);
  const matches = entriesForLocation.filter((r) => {
    if (r.offDay) return false;
    if (r.date >= dateStr || r.date < cutoff) return false;
    return weekdayLabel(r.date) === label;
  });
  if (!matches.length) return null;
  const total = matches.reduce((s, r) => s + (r.soLuong || 0), 0);
  return Math.round(total / matches.length);
}

export function formatDateVN(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return `${weekdayLabel(dateStr)}, ${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

export function escapeHtml(s) {
  return (s || "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

export function matchesSearch(row, term, fields) {
  if (!term) return true;
  const t = term.toLowerCase();
  return fields.some((f) => (row[f] || "").toString().toLowerCase().includes(t));
}

// 1 document trong collection itemCatalog (id = tên đã slug hoá).
// Chỉ giữ ký tự a-z0-9 làm phần dễ đọc, ghép thêm 1 mã hash ngắn để đảm bảo
// không trùng id giữa các nguyên liệu tiếng Việt khác nhau (vd "Gà" vs "Gạo").
export function slugifyItemName(name) {
  const trimmed = (name || "").trim();
  let hash = 0;
  for (let i = 0; i < trimmed.length; i++) hash = (hash * 31 + trimmed.charCodeAt(i)) >>> 0;
  const asciiPart = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return (asciiPart || "item") + "-" + hash.toString(36);
}

// Giá trung bình/đơn vị của 1 nguyên liệu, tính từ lịch sử nhập hàng gần đây
// (tổng thành tiền / tổng số lượng đã nhập trong cửa sổ ngày truyền vào).
export function avgUnitCostMap(ingRows) {
  const map = {};
  ingRows.forEach((r) => {
    if (!r.itemName) return;
    map[r.itemName] = map[r.itemName] || { unit: r.unit, totalQty: 0, totalTien: 0 };
    map[r.itemName].totalQty += r.qty || 0;
    map[r.itemName].totalTien += r.tien || 0;
    if (r.unit) map[r.itemName].unit = r.unit;
  });
  Object.values(map).forEach((v) => {
    v.avgCost = v.totalQty ? v.totalTien / v.totalQty : 0;
  });
  return map;
}
