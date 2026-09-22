// Các hằng số dùng chung nhiều nơi trong app — tách riêng khỏi state.js vì
// đây là dữ liệu KHÔNG BAO GIỜ đổi khi app đang chạy (khác với state.js chứa
// dữ liệu người dùng/Firestore có thể thay đổi).

export const STOCK_WINDOW_DAYS = 365; // khoảng thời gian dùng để tính tồn kho / lịch sử gần đây

export const ITEM_SUGGESTIONS = ["Gà", "Nấm", "Gạo nếp", "Đậu xanh", "Dầu ăn", "Hành phi", "Gia vị", "Nước tương", "Túi/hộp gói"];

// Gợi ý đơn vị — chỉ là gợi ý trong ô nhập tự do (list=datalist), người dùng
// vẫn gõ được bất kỳ đơn vị nào khác (đáp ứng yêu cầu "quyền tạo thêm đơn vị").
export const UNIT_SUGGESTIONS = ["kg", "gr", "lít", "ml", "cái", "gói", "phần", "thùng", "bó", "chai", "hộp", "lon", "túi"];

export const THU_CHI_CATEGORIES = [
  "Doanh thu khác", "Tiền mặt bằng", "Điện nước", "Sửa chữa/bảo trì",
  "Marketing/quảng cáo", "Vận chuyển", "Dụng cụ/vật tư", "Thuế/phí", "Chi phí khác",
];
