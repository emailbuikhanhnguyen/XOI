import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  fmt,
  fmtNum,
  normalizeUnit,
  isoLocal,
  todayISO,
  addDays,
  mondayOf,
  weekdayLabel,
  formatDateVN,
  escapeHtml,
  matchesSearch,
  slugifyItemName,
  avgUnitCostMap,
} from "./calc.js";

describe("fmt / fmtNum", () => {
  it("định dạng tiền VNĐ kiểu vi-VN kèm ký hiệu đ", () => {
    expect(fmt(15000)).toBe("15.000đ");
    expect(fmt(0)).toBe("0đ");
    expect(fmt()).toBe("0đ"); // giá trị rỗng/undefined coi như 0
    expect(fmt(15000.6)).toBe("15.001đ"); // làm tròn
  });

  it("định dạng số kiểu vi-VN không kèm đơn vị", () => {
    expect(fmtNum(1234567)).toBe("1.234.567");
    expect(fmtNum()).toBe("0");
  });
});

describe("normalizeUnit", () => {
  it("gộp các cách gõ khác hoa/thường và khoảng trắng thừa về cùng 1 giá trị", () => {
    expect(normalizeUnit(" Lít ")).toBe("lít");
    expect(normalizeUnit("lít")).toBe("lít");
    expect(normalizeUnit("LÍT")).toBe("lít");
    expect(normalizeUnit()).toBe("");
  });
});

describe("ngày tháng", () => {
  it("isoLocal trả về yyyy-mm-dd theo giờ địa phương", () => {
    expect(isoLocal(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("addDays cộng/trừ đúng, kể cả qua tháng", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-01-05", -5)).toBe("2025-12-31");
  });

  it("mondayOf trả về thứ Hai của tuần chứa ngày đó, kể cả khi ngày đó là Chủ nhật", () => {
    expect(mondayOf("2026-01-07")).toBe("2026-01-05"); // Thứ Tư
    expect(mondayOf("2026-01-11")).toBe("2026-01-05"); // Chủ nhật cùng tuần
    expect(mondayOf("2026-01-05")).toBe("2026-01-05"); // đã là Thứ Hai
  });

  it("weekdayLabel và formatDateVN trả về nhãn tiếng Việt đúng", () => {
    expect(weekdayLabel("2026-01-05")).toBe("T2");
    expect(weekdayLabel("2026-01-11")).toBe("CN");
    expect(formatDateVN("2026-01-05")).toBe("T2, 05/01/2026");
  });

  describe("todayISO", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 8, 22, 10, 0, 0));
    });
    afterEach(() => vi.useRealTimers());

    it("trả về ngày hiện tại dạng yyyy-mm-dd", () => {
      expect(todayISO()).toBe("2026-09-22");
    });
  });
});

describe("escapeHtml", () => {
  it("escape đủ 5 ký tự nguy hiểm để chống XSS khi chèn vào innerHTML", () => {
    expect(escapeHtml(`<b>A & "B" 'C'</b>`)).toBe(
      "&lt;b&gt;A &amp; &quot;B&quot; &#39;C&#39;&lt;/b&gt;"
    );
  });

  it("chịu được giá trị rỗng/undefined", () => {
    expect(escapeHtml()).toBe("");
    expect(escapeHtml("")).toBe("");
  });
});

describe("matchesSearch", () => {
  const row = { name: "Gà chiên", note: "" };

  it("khớp không phân biệt hoa thường trên các field chỉ định", () => {
    expect(matchesSearch(row, "chiên", ["name"])).toBe(true);
    expect(matchesSearch(row, "CHIÊN", ["name"])).toBe(true);
  });

  it("không khớp khi không tìm thấy trong field nào", () => {
    expect(matchesSearch(row, "xyz", ["name", "note"])).toBe(false);
  });

  it("từ khoá rỗng luôn khớp (không lọc gì)", () => {
    expect(matchesSearch(row, "", ["name"])).toBe(true);
  });
});

describe("slugifyItemName", () => {
  it("sinh id ổn định (cùng input luôn ra cùng output)", () => {
    expect(slugifyItemName("Gà")).toBe(slugifyItemName("Gà"));
  });

  it("2 tên khác nhau không được đụng id nhau, kể cả khi phần ASCII giống nhau", () => {
    // "Gà" và "Gạo" cùng rụng dấu về gần giống ascii nhưng hash phải khác
    expect(slugifyItemName("Gà")).not.toBe(slugifyItemName("Gạo"));
  });

  it("tên rỗng/toàn khoảng trắng vẫn ra 1 id hợp lệ, không rỗng", () => {
    expect(slugifyItemName("   ")).toBe("item-0");
    expect(slugifyItemName("   ").length).toBeGreaterThan(0);
  });
});

describe("avgUnitCostMap", () => {
  it("tính giá trung bình/đơn vị = tổng thành tiền / tổng số lượng theo từng nguyên liệu", () => {
    const rows = [
      { itemName: "Gà", qty: 2, tien: 200000, unit: "kg" },
      { itemName: "Gà", qty: 3, tien: 280000, unit: "kg" },
      { itemName: "", qty: 1, tien: 1 }, // dòng thiếu itemName phải bị bỏ qua
    ];
    const map = avgUnitCostMap(rows);
    expect(map["Gà"].totalQty).toBe(5);
    expect(map["Gà"].totalTien).toBe(480000);
    expect(map["Gà"].avgCost).toBe(96000);
    expect(map[""]).toBeUndefined();
  });

  it("nguyên liệu chưa nhập lần nào (tổng số lượng = 0) không chia cho 0", () => {
    const map = avgUnitCostMap([{ itemName: "Nấm", qty: 0, tien: 0, unit: "kg" }]);
    expect(map["Nấm"].avgCost).toBe(0);
  });
});
