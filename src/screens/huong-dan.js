/* ===================== HƯỚNG DẪN SỬ DỤNG ===================== */
// Màn hình tĩnh (không đọc/ghi Firestore) — nội dung hướng dẫn nằm sẵn trong
// template #tpl-huong-dan ở index.html, dùng <details>/<summary> để mở/đóng
// từng mục mà không cần JS xử lý gì thêm. Mục đích: nhân viên tự tra cứu cách
// dùng app thay vì phải hỏi trực tiếp chủ quán mỗi khi thắc mắc.
import { mount } from "../ui.js";

export function renderHuongDan() {
  mount("huong-dan");
}
