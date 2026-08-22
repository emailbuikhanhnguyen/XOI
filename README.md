# 🌿 Sổ Xôi — Chấm công · Lương · Nguyên liệu · Doanh thu

App web (PWA) thay thế bảng tính Google Sheets chấm công bán xôi. Nhiều nhân viên
cùng nhập dữ liệu trên điện thoại, chủ quán xem báo cáo tổng hợp theo thời gian thực.

## Tính năng

- **Đăng nhập** theo tài khoản riêng cho từng người (email/mật khẩu), phân quyền
  **Nhân viên** / **Chủ quán**.
- **Chấm công**: mỗi ngày nhập lương cơ bản, số lượng bán, thưởng, tổng, số đơn
  ship, số xôi ế/dẹp, ghi chú — giống hệt cấu trúc bảng "BẢNG CHẤM CÔNG TUẦN" cũ.
  Có thể đánh dấu "Nghỉ". Sửa/xoá phiếu đã nhập trong lịch sử 7/30/90 ngày.
- **Nguyên liệu**: nhập gà (kg), nấm (gr), thành tiền mỗi lần nhập hàng.
- **Báo cáo (chủ quán)**: chọn khoảng ngày (tuần này/tháng này/7 ngày/tuỳ chọn) →
  xem doanh thu ước tính, tổng số lượng bán, chi phí nguyên liệu, tổng lương +
  thưởng, lợi nhuận ước tính, bảng theo từng nhân viên, biểu đồ doanh thu theo
  ngày, và **quyết toán theo tuần** (điều chỉnh +/-, ghi chú giữ lại tiền thối,
  đánh dấu đã thanh toán) — thay cho dòng "Thực nhận / đã TT" trong sheet cũ.
  Có nút **xuất CSV**.
- **Nhân viên (chủ quán)**: tạo tài khoản đăng nhập cho nhân viên mới, bật/tắt
  tài khoản, cài đặt giá bán mỗi phần xôi (để tính doanh thu ước tính) và lương
  cơ bản mặc định.
- Là **PWA**: có thể "Thêm vào màn hình chính" trên điện thoại, dùng được khi
  mất mạng ở mức xem lại giao diện (dữ liệu cần mạng để đồng bộ).

## Cấu trúc file

```
index.html              Khung giao diện + toàn bộ template các màn hình
styles.css               Giao diện (tông màu lá chuối – xôi gấc – nghệ)
app.js                    Toàn bộ logic: đăng nhập, đọc/ghi dữ liệu, tính toán
firebase-config.js        Nơi bạn dán cấu hình project Firebase của mình
firestore.rules           Luật bảo mật dữ liệu (deploy lên Firebase)
manifest.webmanifest       Khai báo PWA
sw.js                      Service worker (chạy offline phần giao diện)
icons/                      Icon cài đặt lên màn hình điện thoại
```

## 1. Tạo Firebase project (miễn phí)

1. Vào https://console.firebase.google.com → **Add project** → đặt tên (vd
   `so-xoi`) → tạo xong.
2. Vào **Build → Authentication → Get started** → tab **Sign-in method** →
   bật **Email/Password**.
3. Vào **Build → Firestore Database → Create database** → chọn **Production
   mode** → chọn khu vực gần Việt Nam (vd `asia-southeast1`).
4. Vào **Project settings** (biểu tượng bánh răng) → mục **Your apps** → bấm
   biểu tượng **</>** (Web) → đặt tên app → **Register app**. Firebase sẽ hiện
   một đoạn `firebaseConfig = {...}` — copy các giá trị đó.

## 2. Điền cấu hình vào project

Mở file `firebase-config.js`, dán đúng các giá trị Firebase vừa copy vào:

```js
export const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "...",
};
```

> Đây **không phải** khoá bí mật — Firebase web config vốn công khai được,
> bảo mật thật sự nằm ở `firestore.rules`.

## 3. Deploy luật bảo mật Firestore

Cách nhanh nhất (không cần cài gì): mở **Firestore Database → Rules** trong
Firebase Console, xoá hết nội dung mặc định, dán toàn bộ nội dung file
`firestore.rules` vào, bấm **Publish**.

## 4. Tạo tài khoản Chủ quán đầu tiên

Vì chỉ "Chủ quán" mới tạo được tài khoản khác trong app, tài khoản chủ quán
**đầu tiên** cần tạo thủ công một lần:

1. **Authentication → Users → Add user** → nhập email + mật khẩu cho chính bạn.
2. Copy **User UID** vừa tạo (cột UID trong danh sách).
3. **Firestore Database → Start collection** → Collection ID: `users` → Document
   ID: dán đúng UID vừa copy → thêm các field:
   - `name` (string): tên bạn, vd `Chị Hai`
   - `role` (string): `admin`
   - `email` (string): email vừa tạo
   - `active` (boolean): `true`
4. Lưu lại. Giờ bạn có thể đăng nhập vào app bằng email/mật khẩu này với vai
   trò Chủ quán, và tự tạo tài khoản cho các nhân viên khác ngay trong app
   (mục **Nhân viên**).

## 5. Đưa lên GitHub và bật GitHub Pages

```bash
git init
git add .
git commit -m "Sổ Xôi - chấm công & doanh thu"
git branch -M main
git remote add origin https://github.com/<tên-bạn>/<tên-repo>.git
git push -u origin main
```

Sau đó vào repo trên GitHub → **Settings → Pages** → mục **Source** chọn
nhánh `main`, thư mục `/ (root)` → **Save**. Sau 1–2 phút, app sẽ chạy tại:

```
https://<tên-bạn>.github.io/<tên-repo>/
```

Mở link đó trên điện thoại → trình duyệt sẽ gợi ý **"Thêm vào Màn hình
chính"** để dùng như một app thật.

## 6. Ghi chú vận hành

- **Thưởng** không tự tính (mỗi quán có cách tính khác nhau tuỳ số ship/số dẹp),
  bạn nhập tay và ghi chú lý do — giống cách làm trong sheet cũ.
- **Tổng** tự cộng Lương + Thưởng khi bạn nhập, nhưng vẫn có thể sửa tay nếu
  cần.
- **Doanh thu ước tính** trong Báo cáo = Số lượng bán × Giá bán mỗi phần (đặt
  ở mục Nhân viên → Cài đặt quán). Đây là ước tính, không thay cho sổ thu tiền
  thực tế.
- Mục **Quyết toán theo tuần** nhóm phiếu chấm công theo tuần Thứ 2 → Thứ 7,
  cho phép chủ quán ghi số tiền điều chỉnh (giữ lại/thưởng thêm) và đánh dấu
  đã thanh toán — thay cho các dòng "Thực nhận / đã TT / Giữ lại" trong sheet.

## Nâng cấp về sau (tuỳ chọn)

- Thêm Cloud Functions để chủ quán tạo tài khoản nhân viên mà không cần mật
  khẩu tạm (gửi link mời qua email).
- Thêm biểu đồ lợi nhuận theo tháng, xuất báo cáo PDF.
- Thêm ghi nhận nhiều điểm bán nếu quán mở rộng.
