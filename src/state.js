// STATE dùng chung xuyên suốt nhiều màn hình (trước đây là các biến `let`
// rời rạc ở đầu app.js). Gom vào 1 object `state` duy nhất vì với ES module
// gốc (không bundler), các module khác import biến `let` thì KHÔNG thể gán
// lại được (import binding chỉ đọc) — nên mọi nơi cần SỬA dữ liệu này phải
// gán qua thuộc tính, vd `state.profile = ...`, KHÔNG bao giờ gán lại cả
// biến `state`.
//
// Lưu ý: các biến chỉ dùng riêng trong 1 màn hình (vd cache danh sách nhập
// kho, id đang sửa...) KHÔNG nằm ở đây — chúng vẫn là `let` khai báo ngay
// trong file màn hình tương ứng (src/screens/*.js), vì chỉ file đó cần đọc.
export const state = {
  currentUser: null,
  profile: null, // { name, role, email, locationId }
  staffDirectory: {}, // uid -> {name, role, locationId, active, email}
  locationsDirectory: {}, // id -> {name, type: 'kitchen'|'point', address, giaBan, luongMacDinh, active}
  settings: { giaBan: 15000, luongMacDinh: 60000 }, // fallback mặc định khi 1 điểm chưa cấu hình
  itemCatalog: {}, // itemName -> { unit, qtyPerPortion, threshold } — định mức & ngưỡng cảnh báo (settings/itemCatalog)
};

export function staffName(uid) { return state.staffDirectory[uid]?.name || "Không rõ"; }
export function locationName(id) { return state.locationsDirectory[id]?.name || (id ? "(điểm đã xoá)" : "Chưa gán điểm"); }
export function locationGiaBan(id) { return state.locationsDirectory[id]?.giaBan ?? state.settings.giaBan ?? 0; }
export function isAdmin() { return state.profile?.role === "admin"; }
export function myLocation() { return state.locationsDirectory[state.profile?.locationId] || null; }
export function activeLocations() { return Object.entries(state.locationsDirectory).filter(([, l]) => l.active !== false); }
export function kitchenLocations() { return activeLocations().filter(([, l]) => l.type === "kitchen"); }
export function pointLocations() { return activeLocations().filter(([, l]) => l.type === "point"); }

// Điểm bếp mà người dùng hiện tại thao tác nhập/xuất kho (mặc định điểm đầu tiên nếu là admin)
export function operatingKitchenId() {
  if (myLocation()?.type === "kitchen") return state.profile.locationId;
  const list = kitchenLocations();
  return list.length ? list[0][0] : null;
}
export function isKitchenContext() { return isAdmin() || myLocation()?.type === "kitchen"; }
