// Tải dữ liệu dùng chung (staff/locations/settings/itemCatalog) + các hàm
// fetch theo khoảng ngày (entries/ingredients/transfers/orders/thuchi) —
// dùng chung cho nhiều màn hình, không đụng tới DOM.
import {
  collection, doc, getDoc, getDocs, query, where, orderBy,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { db } from "./firebase-init.js";
import { state } from "./state.js";
import { reportError } from "./ui.js";
import { todayISO, addDays, avgUnitCostMap } from "./calc.js";
import { STOCK_WINDOW_DAYS } from "./constants.js";

// Lưu 1 thao tác ghi Firestore kiểu "optimistic": khi đang mất mạng, promise
// của addDoc/updateDoc/setDoc sẽ treo tới lúc có mạng lại (đặc tính của
// Firestore offline persistence) — nên ở đây không chờ mà coi như đã lưu cục
// bộ ngay (dữ liệu đã nằm trong cache offline và sẽ tự đồng bộ), đồng thời
// vẫn bắt lỗi ngầm nếu cuối cùng ghi thất bại. Khi đang có mạng thì chờ bình
// thường như cũ để bắt lỗi (vd. sai quyền) ngay lúc đó.
export async function saveOp(writePromiseFactory, onDone) {
  const p = writePromiseFactory();
  if (!navigator.onLine) {
    p.catch((err) => reportError(err, "Đồng bộ thất bại: " + (err.message || "")));
    if (onDone) await onDone(false);
    return;
  }
  try {
    await p;
    if (onDone) await onDone(true);
  } catch (err) {
    reportError(err, "Lỗi khi lưu: " + (err.message || "Thử lại nhé."));
  }
}

export async function loadStaffDirectory() {
  const snap = await getDocs(collection(db, "users"));
  state.staffDirectory = {};
  snap.forEach((d) => { state.staffDirectory[d.id] = d.data(); });
}

export async function loadLocationsDirectory() {
  const snap = await getDocs(collection(db, "locations"));
  state.locationsDirectory = {};
  snap.forEach((d) => { state.locationsDirectory[d.id] = d.data(); });
}

// Lỗi ở đây KHÔNG được để chặn đăng nhập (vẫn giữ nguyên `state.settings`
// mặc định đã khai báo ở state.js) — nhưng vẫn phải báo cho người dùng biết,
// vì giá bán/lương mặc định sai lệch sẽ âm thầm làm sai số liệu lương/doanh
// thu ở khắp app mà không có dấu hiệu gì khác.
export async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, "settings", "general"));
    if (snap.exists()) state.settings = { ...state.settings, ...snap.data() };
  } catch (err) {
    reportError(err, "Không tải được cài đặt (giá bán/lương mặc định) — đang dùng giá trị dự phòng, thử tải lại trang.");
  }
}

// Định mức nguyên liệu/phần (BOM) + ngưỡng cảnh báo tồn kho, mỗi nguyên liệu.
// Cũng không chặn đăng nhập nếu lỗi, nhưng phải báo: thiếu danh mục này thì
// cảnh báo sắp hết nguyên liệu, giá vốn NL trong Báo cáo, và gợi ý đặt hàng
// ở điểm bán sẽ âm thầm trống/sai mà không có dấu hiệu gì khác.
export async function loadItemCatalog() {
  try {
    const snap = await getDocs(collection(db, "itemCatalog"));
    state.itemCatalog = {};
    snap.forEach((d) => {
      const data = d.data();
      if (data.itemName) state.itemCatalog[data.itemName] = { id: d.id, ...data };
    });
  } catch (err) {
    reportError(err, "Không tải được danh mục nguyên liệu (định mức/ngưỡng cảnh báo) — thử tải lại trang.");
  }
}

// Giá vốn nguyên liệu ước tính / 1 phần xôi bán ra = tổng (định mức × giá TB/đơn vị)
// trên các nguyên liệu đã được đặt định mức ở mục Quản lý.
// Cố ý im lặng khi lỗi (chỉ console.error, không toast): hàm này chạy như 1
// phần phụ của việc tải Báo cáo (loadReport() có toast riêng cho lỗi tổng
// thể), và trả về 0 đã có ý nghĩa sẵn là "chưa đặt định mức" — báo lỗi thêm
// ở đây dễ gây hiểu nhầm/trùng lặp hơn là giúp ích.
export async function computeGiaVonPerPhan() {
  try {
    const from = addDays(todayISO(), -STOCK_WINDOW_DAYS);
    const rows = await fetchIngredientsByRange(from, todayISO());
    const costMap = avgUnitCostMap(rows);
    let total = 0;
    Object.entries(state.itemCatalog).forEach(([name, cat]) => {
      if (!cat.qtyPerPortion) return;
      const c = costMap[name];
      total += (cat.qtyPerPortion || 0) * (c ? c.avgCost : 0);
    });
    return total;
  } catch (err) {
    console.error(err);
    return 0;
  }
}

export async function fetchEntriesByUid(uid) {
  const q = query(collection(db, "entries"), where("uid", "==", uid));
  const snap = await getDocs(q);
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  rows.sort((a, b) => (a.date < b.date ? 1 : -1));
  return rows;
}

export async function fetchEntriesByRange(from, to) {
  const q = query(collection(db, "entries"), where("date", ">=", from), where("date", "<=", to), orderBy("date", "asc"));
  const snap = await getDocs(q);
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  return rows;
}

export async function fetchIngredientsByRange(from, to) {
  const q = query(collection(db, "ingredients"), where("date", ">=", from), where("date", "<=", to), orderBy("date", "asc"));
  const snap = await getDocs(q);
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  return rows;
}

export async function fetchTransfersByRange(from, to) {
  const q = query(collection(db, "transfers"), where("date", ">=", from), where("date", "<=", to), orderBy("date", "asc"));
  const snap = await getDocs(q);
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  return rows;
}

export async function fetchOrdersByRange(from, to) {
  const q = query(collection(db, "orders"), where("date", ">=", from), where("date", "<=", to), orderBy("date", "asc"));
  const snap = await getDocs(q);
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  return rows;
}

export async function fetchThuChiByRange(from, to) {
  const q = query(collection(db, "thuchi"), where("date", ">=", from), where("date", "<=", to), orderBy("date", "asc"));
  const snap = await getDocs(q);
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  return rows;
}
