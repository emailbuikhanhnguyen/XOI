// Các hằng số dùng chung nhiều nơi trong app — tách riêng khỏi state.js vì
// đây là dữ liệu KHÔNG BAO GIỜ đổi khi app đang chạy (khác với state.js chứa
// dữ liệu người dùng/Firestore có thể thay đổi).

export const STOCK_WINDOW_DAYS = 365; // khoảng thời gian dùng để tính tồn kho / lịch sử gần đây

// Số ngày trong quá khứ được phép chọn khi nhập ngày chấm công / nhập kho /
// chuyển hàng / thu chi (không tính ngày hôm nay) — hạn chế gõ nhầm ngày rất
// xa (nhầm năm...) hoặc "sửa khống" số liệu quá lâu sau khi việc đã xảy ra.
// KHÔNG áp dụng cho ngày đặt hàng (order-date) vì đặt hàng luôn hướng tới
// tương lai gần, không phải ghi nhận việc đã xảy ra.
export const DATE_ENTRY_PAST_DAYS = 30;

// Số ngày lịch sử dùng để ước tính "gợi ý chuẩn bị hôm nay" cho từng điểm
// bán (trung bình soLuong các ngày cùng Thứ trong khoảng này) — xem
// suggestedQtyForWeekday() ở calc.js.
export const FORECAST_LOOKBACK_DAYS = 28;

// Trong vòng bao nhiêu ngày tới thì coi là "sắp hết hạn" và cảnh báo ở bảng
// Tồn kho hiện tại (nguyên liệu có ghi hạn sử dụng khi nhập kho).
export const EXPIRY_WARN_DAYS = 3;

export const ITEM_SUGGESTIONS = ["Gà", "Nấm", "Gạo nếp", "Đậu xanh", "Dầu ăn", "Hành phi", "Gia vị", "Nước tương", "Túi/hộp gói"];

// Gợi ý đơn vị — chỉ là gợi ý trong ô nhập tự do (list=datalist), người dùng
// vẫn gõ được bất kỳ đơn vị nào khác (đáp ứng yêu cầu "quyền tạo thêm đơn vị").
export const UNIT_SUGGESTIONS = ["kg", "gr", "lít", "ml", "cái", "gói", "phần", "thùng", "bó", "chai", "hộp", "lon", "túi"];

export const THU_CHI_CATEGORIES = [
  "Doanh thu khác", "Tiền mặt bằng", "Điện nước", "Sửa chữa/bảo trì",
  "Marketing/quảng cáo", "Vận chuyển", "Dụng cụ/vật tư", "Thuế/phí", "Chi phí khác",
];
