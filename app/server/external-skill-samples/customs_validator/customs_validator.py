# -*- coding: utf-8 -*-
"""通关与单证规则校验工具箱：JSON stdin -> JSON stdout
功能：集装箱号 ISO 6346 校验、字段长度校验、件重尺/价格对账（区分计价数量与包装件数）、
面积全链条校验（长×宽×每箱片数×箱数）、Excel 混装清单与发票交叉核对、反推单价、贸易术语运保费联动校验。

1.1.9 修正：
  - 字段名写错时不再静默通过：未识别的字段会列进 warnings，缺数据的检查项列进 checksSkipped；
  - 计价数量与面积交叉核对：按面积计价但发货面积与计价面积不符时报错（不再因缺 pcsPerPackage 而跳过）；
  - 从 Excel 读出的文本数字（"10"）自动转成数值，不再崩溃；
  - 贸易术语允许带地点（CIF Shanghai、DAP 上海）；
  - 按 Incoterms 2020 修正保险要求：只有 CIF、CIP 要求卖方投保，DAP/DPU/DDP 不要求；
  - 缺总价时不再算作错误，改为提示无法核对；
  - 同一个价格差额只报一次；
  - “价格必须整数”改为可选规则（requireIntegerPrices，默认关闭），且为警告级。
"""
import sys, json, re, math

# ---------------------------------------------------------------- 参数解析与输出

def _load_params():
    raw = sys.stdin.buffer.read()
    for enc in ("utf-8", "gbk", "utf-16"):
        try:
            return json.loads(raw.decode(enc) or "{}")
        except Exception:
            continue
    return {}


def out(obj):
    sys.stdout.buffer.write(json.dumps(obj, ensure_ascii=False, indent=2).encode("utf-8"))


def num(value):
    """A number, or a number written as text (Excel imports do this constantly)."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value if math.isfinite(value) else None
    if isinstance(value, str):
        text = value.strip().replace(",", "").replace("，", "").replace(" ", "")
        text = re.sub(r"(?i)(?:kg|kgs|m2|m²|m³|m3|pcs|pieces|ctns|件|片|箱|公斤|千克)$", "", text)
        if not text:
            return None
        try:
            value = float(text)
            return value if math.isfinite(value) else None
        except ValueError:
            return None
    return None


# ---------------------------------------------------------------- 集装箱号

_ISO_VALS = [v for v in range(10, 39) if v % 11 != 0]


def letter_val(c):
    return _ISO_VALS[ord(c) - 65]


def check_container(no):
    no = re.sub(r"[^A-Za-z0-9]", "", no or "").upper()
    if len(no) != 11:
        return {"container": no, "valid": False, "reason": f"长度应为11位（含1位校验码），实际 {len(no)} 位"}
    if not re.match(r"^[A-Z]{4}\d{7}$", no):
        return {"container": no, "valid": False, "reason": "格式应为 4字母(箱主+设备代码) + 7数字"}
    letters = no[:4]
    digits = no[4:]
    total = 0
    for i, ch in enumerate(letters):
        total += letter_val(ch) * (2 ** i)
    for i, ch in enumerate(digits[:6]):
        total += int(ch) * (2 ** (i + 4))
    check = total % 11 % 10
    ok = check == int(digits[6])
    return {"container": no, "valid": ok, "expectedCheckDigit": check, "actualCheckDigit": int(digits[6]),
            "ownerCode": letters[:3], "equipmentCategory": letters[3],
            "reason": "ISO 6346 校验通过" if ok else f"校验位错误：应为 {check}"}


# ---------------------------------------------------------------- 通用对账

def check_field(name, value, limit):
    s = str(value or "")
    return {"field": name, "value": s, "length": len(s), "limit": limit,
            "valid": len(s) <= limit,
            "reason": "" if len(s) <= limit else f"超长 {len(s) - limit} 字符（限 {limit}）"}


def recon(name, unit, qty, total, tol=0.01, unitLabel="unit", qtyLabel="qty"):
    """unit × qty 与 total 比较。三者缺一就不做判断，由调用方记录“未核对”。"""
    if unit is None or qty is None or total is None:
        return None
    expect = unit * qty
    diff = total - expect
    return {"item": name, "calc": f"{unit} {unitLabel} × {qty} {qtyLabel} = {round(expect, 4)}",
            "calcTotal": round(expect, 4), "declaredTotal": total,
            "match": abs(diff) <= tol, "difference": round(diff, 4)}


# ---------------------------------------------------------------- 字段名归一
# 单据里的字段名五花八门，认不出来的要明说，而不是当作没有这个检查。
ITEM_ALIASES = {
    "qty": "qty", "quantity": "qty", "qtyM2": "qty", "area": "qty", "计价数量": "qty",
    "packages": "packages", "crates": "packages", "cartons": "packages", "ctns": "packages",
    "箱子数": "packages", "件数": "packages", "箱数": "packages",
    "unitPrice": "unitPrice", "unit_price": "unitPrice", "price": "unitPrice", "单价": "unitPrice",
    "totalPrice": "totalPrice", "total_price": "totalPrice", "amount": "totalPrice",
    "总价": "totalPrice", "金额": "totalPrice",
    "unitWeightKg": "unitWeightKg", "unit_weight_kg": "unitWeightKg", "单箱毛重": "unitWeightKg",
    "totalWeightKg": "totalWeightKg", "total_weight_kg": "totalWeightKg", "总毛重": "totalWeightKg",
    "unitNetWeightKg": "unitNetWeightKg", "unit_net_weight_kg": "unitNetWeightKg", "单箱净重": "unitNetWeightKg",
    "totalNetWeightKg": "totalNetWeightKg", "total_net_weight_kg": "totalNetWeightKg", "总净重": "totalNetWeightKg",
    "lengthMm": "lengthMm", "length": "lengthMm", "长": "lengthMm",
    "widthMm": "widthMm", "width": "widthMm", "宽": "widthMm",
    "pcsPerPackage": "pcsPerPackage", "pcs_per_package": "pcsPerPackage", "每箱片数": "pcsPerPackage",
    "crateAreaM2": "crateAreaM2", "crate_area_m2": "crateAreaM2", "单箱面积": "crateAreaM2",
    "totalArea": "totalArea", "total_area": "totalArea", "总面积": "totalArea",
    "pieceArea": "pieceArea", "piece_area": "pieceArea", "pieceAreaM2": "pieceArea", "单片面积": "pieceArea",
    "pieces": "pieces", "片数": "pieces",
    "unit": "qtyUnit", "qtyUnit": "qtyUnit", "quantityUnit": "qtyUnit", "计价单位": "qtyUnit",
    "name": "name", "item": "name", "品名": "name",
}
KNOWN_ITEM_KEYS = set(ITEM_ALIASES) | {"note", "remark"}

TOP_LEVEL_KEYS = {
    "containers", "contractNo", "invoiceNo", "blNo", "goodsName", "incoterm", "freight", "insurance",
    "goodsValue", "invoiceTotal", "totalPackages", "totalGrossWeightKg", "totalVolumeM3", "totalArea",
    "lineItems", "excelRows", "requireIntegerPrices",
}


def normalize_item(raw):
    """Map every recognised spelling onto one key and say which keys were not understood."""
    item, unknown = {}, []
    for key, value in (raw or {}).items():
        target = ITEM_ALIASES.get(key) or ITEM_ALIASES.get(str(key).strip())
        if target is None:
            if key not in KNOWN_ITEM_KEYS and not str(key).startswith("_"):
                unknown.append(key)
            continue
        if target not in item or item.get(target) in (None, ""):
            item[target] = value
    return item, unknown


# ---------------------------------------------------------------- 主流程

INCOTERM_FREIGHT = {"CFR", "CPT", "CIF", "CIP", "DAP", "DPU", "DDP"}
INCOTERM_INSURANCE = {"CIF", "CIP"}  # Incoterms 2020: only these oblige the seller to insure
KNOWN_INCOTERMS = {"EXW", "FCA", "FAS", "FOB", "CFR", "CPT", "CIF", "CIP", "DAP", "DPU", "DDP"}


def parse_incoterm(value):
    """CIF / cif / CIF Shanghai / DAP 上海 -> CIF, DAP."""
    match = re.match(r"\s*([A-Za-z]{3})", str(value or ""))
    return match.group(1).upper() if match else ""


def main():
    try:
        p = _load_params()
    except Exception as e:
        out({"error": f"参数解析失败: {e}"})
        return 1
    if not isinstance(p, dict):
        out({"error": "参数必须是 JSON 对象。"})
        return 1

    findings, errors, warns = [], [], []
    skipped = []

    unknown_top = [k for k in p if k not in TOP_LEVEL_KEYS]
    for key in unknown_top:
        warns.append({"item": "参数", "field": key,
                      "reason": f"未识别的顶层字段 {key}，没有参与任何校验；请确认字段名。"})

    for key in ("freight", "insurance", "goodsValue", "invoiceTotal", "totalPackages",
                "totalGrossWeightKg", "totalVolumeM3", "totalArea"):
        if key in p and p[key] not in (None, ""):
            raw_number = p[key]
            p[key] = num(raw_number)
            if p[key] is None:
                warns.append({"item": "参数", "field": key, "value": raw_number,
                              "reason": "已提供数值，但格式无法解析；相关核对将跳过。"})
    # 1) 集装箱号
    containers = p.get("containers") or []
    if isinstance(containers, str):
        containers = [v.strip() for v in re.split(r"[,，;；\n]+", containers) if v.strip()]
    if not isinstance(containers, list):
        errors.append({"item": "containers", "reason": "必须提供箱号字符串或字符串数组。"})
        containers = []
    for no in containers:
        r = check_container(str(no))
        (findings if r["valid"] else errors).append(r)

    # 2) 字段长度
    limits = {"contractNo": 32, "invoiceNo": 32, "blNo": 32, "goodsName": 256}
    for key, limit in limits.items():
        value = p.get(key)
        if value:
            r = check_field(key, value, limit)
            (findings if r["valid"] else errors).append(r)

    # 3) 明细行
    for index, raw in enumerate(p.get("lineItems") or [], start=1):
        if not isinstance(raw, dict):
            errors.append({"item": f"第{index}行", "reason": "明细行必须是对象。"})
            continue
        it, unknown = normalize_item(raw)
        name = str(it.get("name") or it.get("品名") or f"第{index}行")[:60]
        if unknown:
            warns.append({"item": f"{name}-字段名", "unknownFields": unknown,
                          "reason": f"这些字段名没有识别：{'、'.join(map(str, unknown))}；相关校验被跳过。"
                                    f"可用写法见工具说明（qty/quantity、unitPrice/unit_price、totalPrice/amount 等）。"})
        for key in ("qty", "packages", "unitPrice", "totalPrice", "unitWeightKg", "totalWeightKg",
                    "unitNetWeightKg", "totalNetWeightKg", "lengthMm", "widthMm", "pcsPerPackage",
                    "crateAreaM2", "totalArea", "pieceArea", "pieces"):
            if key in it:
                raw_number = it[key]
                it[key] = num(raw_number)
                if raw_number not in (None, "") and it[key] is None:
                    warns.append({"item": name, "field": key, "value": raw_number,
                                  "reason": "已提供数值，但格式无法解析；相关核对将跳过。"})

        qty = it.get("qty")
        pkgs = it.get("packages")

        # 3a) 金额 = 单价 × 计价数量
        if it.get("unitPrice") is not None and qty is not None:
            if it.get("totalPrice") is None:
                skipped.append({"item": f"{name}-金额", "reason": "没有提供总价，无法核对 单价×数量 是否等于总价。"})
            else:
                r = recon(f"{name}-金额", it["unitPrice"], qty, it["totalPrice"], 0.01,
                          unitLabel="单价", qtyLabel="计价数量")
                (findings if r["match"] else errors).append(r)
        elif it.get("totalPrice") is not None:
            skipped.append({"item": f"{name}-金额", "reason": "缺少单价或计价数量，无法反算总价。"})

        if it.get("totalPrice") is not None and qty:
            findings.append({"item": f"{name}-反推单价",
                             "impliedUnitPrice": round(it["totalPrice"] / qty, 6),
                             "calc": f"{it['totalPrice']} ÷ {qty} = {round(it['totalPrice'] / qty, 6)}"})

        # 3b) 毛重 / 净重 = 单箱 × 箱数
        for key, unit_key, label in (("totalWeightKg", "unitWeightKg", "毛重"),
                                     ("totalNetWeightKg", "unitNetWeightKg", "净重")):
            if it.get(unit_key) is not None and pkgs is not None:
                if it.get(key) is None:
                    skipped.append({"item": f"{name}-{label}", "reason": f"没有有效的总{label}（缺失或格式无法解析），无法核对。"})
                else:
                    r = recon(f"{name}-{label}", it[unit_key], pkgs, it[key], 0.5,
                              unitLabel=f"单箱{label}kg", qtyLabel="箱数")
                    (findings if r["match"] else errors).append(r)
        if it.get("totalNetWeightKg") is not None and it.get("totalWeightKg") is not None:
            if it["totalNetWeightKg"] > it["totalWeightKg"]:
                errors.append({"item": f"{name}-净毛重",
                               "reason": f"总净重 {it['totalNetWeightKg']} kg 大于总毛重 {it['totalWeightKg']} kg"})

        # 3c) Independently derive every available area, regardless of packaging fields.
        length, width = it.get("lengthMm"), it.get("widthMm")
        piece = it.get("pieceArea")
        if length is not None and width is not None:
            calculated_piece = length * width / 1e6
            check = {"item": f"{name}-单片面积", "pieceAreaM2": round(calculated_piece, 6)}
            if piece is not None:
                check.update(declaredPieceArea=piece, match=abs(piece - calculated_piece) <= 0.001)
                (findings if check["match"] else warns).append(check)
            else:
                findings.append(check)
            piece = calculated_piece
        crate = it.get("crateAreaM2")
        if piece is not None and it.get("pcsPerPackage") is not None:
            calculated_crate = piece * it["pcsPerPackage"]
            check = {"item": f"{name}-单箱面积", "calcCrateArea": round(calculated_crate, 4)}
            if crate is not None:
                check.update(declaredCrateArea=crate, match=abs(crate - calculated_crate) <= 0.05)
                (findings if check["match"] else warns).append(check)
            else:
                findings.append(check)
            crate = calculated_crate
        totals = []
        if piece is not None and it.get("pieces") is not None:
            totals.append(("单片面积×片数", piece * it["pieces"]))
        if crate is not None and pkgs is not None:
            totals.append(("单箱面积×箱数", crate * pkgs))
        declared_area = it.get("totalArea")
        if declared_area is not None:
            totals.append(("声明总面积", declared_area))
        if totals:
            base_label, computed_total = totals[0]
            for label, value in totals[1:]:
                check = {"item": f"{name}-面积链核对", "source": label, "baseSource": base_label,
                         "calcTotalArea": round(computed_total, 4), "declaredTotalArea": value,
                         "difference": round(value - computed_total, 4), "match": abs(value - computed_total) <= 0.05}
                (findings if check["match"] else warns).append(check)
        unit = str(it.get("qtyUnit") or "").strip().upper()
        piece_priced = unit in {"PCS", "PC", "PIECE", "PIECES", "EA", "件", "片", "箱"}
        area_fields = ("lengthMm", "widthMm", "pieceArea", "pieces", "pcsPerPackage", "crateAreaM2", "totalArea")
        area_relevant = any(k in it for k in area_fields) or unit in {"M2", "M²", "SQM", "平方米"}
        if qty is not None and not piece_priced and area_relevant:
            if totals:
                for label, total_area in totals:
                    difference = qty - total_area
                    check = {"item": f"{name}-计价数量 vs 面积", "source": label,
                             "calc": f"计价数量 {qty} vs 总面积 {round(total_area, 4)} M²",
                             "difference": round(difference, 4), "match": abs(difference) <= 0.05}
                    (findings if check["match"] else errors).append(check)
            else:
                skipped.append({"item": f"{name}-面积核对",
                                "reason": "提供了部分面积或尺寸数据，但无法算出总面积；请补总面积，或单片面积×总片数，或单箱面积×箱数。"})

    # 4) Excel 混装清单交叉核对
    ex = p.get("excelRows") or []
    if ex:
        rows = []
        bad_rows = []
        for index, row in enumerate(ex, start=1):
            if not isinstance(row, dict):
                bad_rows.append(index)
                continue
            aliases = {
                "container": "container", "containerNo": "container", "箱号": "container",
                "pieces": "pieces", "packages": "pieces", "crates": "pieces", "cartons": "pieces", "件数": "pieces", "箱数": "pieces",
                "weightKg": "weightKg", "weight": "weightKg", "grossWeightKg": "weightKg", "毛重": "weightKg",
                "price": "price", "amount": "price", "totalPrice": "price", "金额": "price",
                "volumeM3": "volumeM3", "volume": "volumeM3", "体积": "volumeM3",
            }
            cleaned = {}
            for key, value in row.items():
                target = aliases.get(str(key).strip())
                if target is None:
                    warns.append({"item": f"Excel第{index}行-字段名", "field": key,
                                  "reason": "未识别此字段，没有参与合计；请使用 pieces/packages、weightKg/weight、price/amount、volumeM3。"})
                    continue
                converted = value if target == "container" else num(value)
                if target != "container" and value not in (None, "") and converted is None:
                    warns.append({"item": f"Excel第{index}行", "field": key, "value": value,
                                  "reason": "数值格式无法解析，相关合计核对将跳过。"})
                if target not in cleaned or cleaned[target] is None:
                    cleaned[target] = converted
            rows.append(cleaned)
        if bad_rows:
            errors.append({"item": "Excel混装清单", "reason": f"第 {bad_rows} 行不是对象，无法读取。"})
        def total_field(key, digits):
            if bad_rows or not rows or any(row.get(key) is None for row in rows):
                return None
            return round(sum(row[key] for row in rows), digits)
        sum_pieces = total_field("pieces", 6)
        sum_weight = total_field("weightKg", 3)
        sum_price = total_field("price", 2)
        sum_vol = total_field("volumeM3", 3)
        summary = {"item": "Excel混装清单汇总", "rowCount": len(rows),
                   "sumPieces": sum_pieces, "sumWeightKg": sum_weight,
                   "sumVolumeM3": sum_vol, "sumPrice": sum_price, "checks": []}
        total_packages = num(p.get("totalPackages"))
        total_weight = num(p.get("totalGrossWeightKg"))
        total_vol = num(p.get("totalVolumeM3"))
        invoice_total = num(p.get("invoiceTotal"))
        checks = [
            ("件数合计 vs 装箱单总箱数", sum_pieces, total_packages, 0),
            ("重量合计 vs 装箱单总毛重", sum_weight, total_weight, 0.5),
            ("体积合计 vs 装箱单总体积", sum_vol, total_vol, 0.001),
            ("价格合计 vs 发票总价", sum_price, invoice_total, 0.01),
        ]
        for label, a, b, tol in checks:
            if b is None or a is None:
                skipped.append({"item": label, "reason": "单据合计或某些 Excel 行的对应字段缺失/无法解析，无法交叉核对。"})
                continue
            c = {"check": label, "excelSum": a, "declared": b, "difference": round(b - a, 4),
                 "match": abs(a - b) <= tol}
            summary["checks"].append(c)
            (findings if c["match"] else errors).append(c)

        if p.get("requireIntegerPrices") is True:
            for r in rows:
                price = r.get("price")
                if price is not None and abs(price - round(price)) > 1e-9:
                    warns.append({"item": "Excel行-价格非整数", "container": r.get("container"),
                                  "price": price, "reason": "按要求价格应为整数（requireIntegerPrices=true）",
                                  "建议值": round(price)})

        findings.append(summary)

    # Unit price does not depend on the optional Excel rows.
    area_total = num(p.get("totalArea"))
    invoice_total = num(p.get("invoiceTotal"))
    if invoice_total is not None and area_total not in (None, 0):
        implied = round(invoice_total / area_total, 6)
        findings.append({"item": "发票-反推单价", "impliedUnitPricePerM2": implied,
                         "calc": f"发票总价 {invoice_total} ÷ 总面积 {area_total} = {implied}"})
    elif invoice_total is not None or area_total is not None:
        skipped.append({"item": "发票-反推单价", "reason": "缺少有效的发票总价或非零总面积，无法反推单价。"})

    # 5) 贸易术语与运保费联动
    raw_incoterm = p.get("incoterm")
    incoterm = parse_incoterm(raw_incoterm)
    freight = num(p.get("freight"))
    insurance = num(p.get("insurance"))
    goods_value = num(p.get("goodsValue"))
    if raw_incoterm:
        if incoterm not in KNOWN_INCOTERMS:
            warns.append({"item": "incoterm", "reason": f"未识别的贸易术语: {raw_incoterm}"})
        else:
            has = set()
            if freight not in (None, 0):
                has.add("freight")
            if insurance not in (None, 0):
                has.add("insurance")
            need = set()
            if incoterm in INCOTERM_FREIGHT:
                need.add("freight")
            if incoterm in INCOTERM_INSURANCE:
                need.add("insurance")
            if need - has:
                labels = {"freight": "运费", "insurance": "保险费"}
                missing = "、".join(labels[item] for item in sorted(need - has))
                warns.append({"item": "incoterm", "incoterm": incoterm,
                              "reason": f"{incoterm} 条件下应包含{missing}，但单据未列明。"})
            if goods_value and freight and incoterm in INCOTERM_FREIGHT:
                net = round(goods_value - (freight or 0) - (insurance or 0), 2)
                warns.append({"item": "incoterm", "incoterm": incoterm,
                              "reason": f"{incoterm} 下需注明运费/保费是否已含在总价 {goods_value} 内；"
                                        f"若已含，扣除运保费后的净货值 = {goods_value} - {freight or 0} - {insurance or 0} = {net}"})

    report = {"passed": findings, "errors": errors, "warnings": warns, "checksSkipped": skipped,
              "summary": {"errorCount": len(errors), "warningCount": len(warns),
                          "skippedCount": len(skipped),
                          "note": "checksSkipped 列出的检查项因为缺少数据没有执行，它们既没有通过也没有失败。"}}
    out(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
