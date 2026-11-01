# -*- coding: utf-8 -*-
"""Excel 结构化快速读取器（支持 .xlsx/.xlsm/.xls）：JSON stdin -> JSON stdout
增强：
1. 自动兼容新版 (.xlsx/.xlsm via openpyxl) 与旧版 (.xls via xlrd)；
2. 输出特殊 number_format；自动扫描表头含“必须整数/最多N位小数”约束但实际值违规的单元格并给出 warnings；
3. 对含大量合并/空白单元格的表单（如报关单），额外输出 nonEmptyCells (坐标->值) 以便精准定位；
4. 日期/时间/Decimal 等类型统一转成文本，避免 json 序列化失败；
5. 公式未被 Excel 计算过（没有缓存值）时，value 为 null 并给出 formula + 提示，不再把公式原文当成结果值；
6. 表头不在第 1 行（上方有标题行）时，自动在前 8 行里定位真正的表头，约束检查照常生效。"""
import sys, os, json, re, unicodedata, datetime, math
from decimal import Decimal


# ----------------------------------------------------------------------------- 1.3.3 长路径
LONG_PATH_THRESHOLD = 200  # at or above this length a path uses the long-path namespace


def fs_path(path):
    r"""The name handed to Windows for one file: long absolute paths use the \\?\ namespace."""
    if os.name != "nt" or not isinstance(path, str) or not path or path.startswith("\\\\?\\") or path.startswith("\\\\.\\"):
        return path
    absolute = os.path.abspath(path)
    if len(absolute) < LONG_PATH_THRESHOLD:
        return path
    if absolute.startswith("\\\\"):
        return "\\\\?\\UNC\\" + absolute[2:]
    return "\\\\?\\" + absolute


def plain_path(path):
    if isinstance(path, str) and path.startswith("\\\\?\\UNC\\"):
        return "\\\\" + path[8:]
    if isinstance(path, str) and path.startswith("\\\\?\\"):
        return path[4:]
    return path


def _install_long_paths():
    r"""Windows refuses paths of 260+ characters unless LongPathsEnabled is set. Every file call of
    this script and of the libraries it loads goes through the functions below, so each of them is
    given the \\?\ form of a long path; short paths are passed on untouched."""
    if os.name != "nt" or getattr(os, "_harness_long_paths", False):
        return
    import builtins
    import io
    import shutil as _shutil

    def first(fn):
        def inner(*args, **kwargs):
            if args and isinstance(args[0], str):
                args = (fs_path(args[0]),) + args[1:]
            return fn(*args, **kwargs)
        inner.__wrapped__ = fn
        return inner

    def pair(fn):
        def inner(src, dst, *args, **kwargs):
            return fn(fs_path(src), fs_path(dst), *args, **kwargs)
        inner.__wrapped__ = fn
        return inner

    opener = first(io.open)
    builtins.open = opener
    io.open = opener
    for name in ("exists", "lexists", "isfile", "isdir", "getsize", "getmtime"):
        setattr(os.path, name, first(getattr(os.path, name)))
    for name in ("stat", "lstat", "listdir", "scandir", "mkdir", "makedirs", "remove", "unlink", "rmdir"):
        setattr(os, name, first(getattr(os, name)))
    for name in ("replace", "rename"):
        setattr(os, name, pair(getattr(os, name)))
    for name in ("copyfile", "copy", "copy2"):
        setattr(_shutil, name, pair(getattr(_shutil, name)))
    os._harness_long_paths = True


_install_long_paths()


def _load_params():
    raw = sys.stdin.buffer.read()
    for enc in ("utf-8", "gbk", "utf-16"):
        try:
            return json.loads(raw.decode(enc) or "{}")
        except Exception:
            continue
    return {}


def _json_default(value):
    """Anything json cannot encode becomes readable text instead of an exception."""
    if isinstance(value, datetime.datetime):
        return value.isoformat(sep=" ")
    if isinstance(value, (datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, datetime.timedelta):
        return str(value)
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    if isinstance(value, (set, tuple)):
        return list(value)
    return str(value)


REQUESTED_PATH = None


def out(obj):
    if REQUESTED_PATH and obj.get("file") and os.path.abspath(REQUESTED_PATH) != os.path.abspath(obj["file"]):
        obj.update(requestedPath=os.path.abspath(REQUESTED_PATH), pathResolved=True,
                   pathResolutionNote="使用了指定目录中唯一的相似文件名，实际路径见 file。")
    encode = lambda value: json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=_json_default).encode("utf-8")
    data = encode(obj)
    if len(data) > 380000 and obj.get("sheets"):
        for sheet in obj["sheets"]:
            sheet.pop("nonEmptyCells", None)
        obj["outputNote"] = "输出较长，省略重复的 nonEmptyCells；完整值见 rows/markdown。"
        data = encode(obj)
    if len(data) > 380000 and obj.get("sheets"):
        obj["truncated"] = True
        while len(data) > 370000 and len(obj["sheets"]) > 1:
            removed = obj["sheets"].pop()
            obj["nextSheet"] = removed["name"]
            obj.setdefault("remainingSheets", []).insert(0, removed["name"])
            data = encode(obj)
        sheet = obj["sheets"][-1]
        key = "rows" if "rows" in sheet else "markdown"
        while len(data) > 370000 and sheet[key]:
            sheet[key].pop()
            sheet["truncated"] = True
            sheet["nextRow"] = sheet.get("startRow", 1) + (len(sheet[key]) if key == "rows" else max(0, len(sheet[key]) - 1))
            data = encode(obj)
        obj["outputNote"] = "达到输出字节上限，部分内容尚未返回；按 nextSheet/nextRow 指示缩小读取范围。"
        if not sheet[key]:
            obj["error"] = "单行内容超出输出上限；请减小 maxColumns，并用 startColumn 分段读取。"
        data = encode(obj)
    if len(data) > 390000:
        data = encode({"error": "单个工作表的元数据或警告超出输出上限，请缩小文件后重试。"})
    sys.stdout.buffer.write(data)


def _norm_name(s):
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", s).replace("\xa0", " ")).strip().lower()


def _norm_nospace(s):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", s).replace("\xa0", "")).lower()


def normalized(value):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", value)).casefold()


def find_file(path):
    requested = plain_path(os.path.abspath(path))
    if os.path.isfile(requested):
        return requested
    directory, basename = os.path.split(requested)
    if not os.path.isdir(directory):
        return None
    matches = [os.path.join(directory, entry.name) for entry in os.scandir(directory)
               if entry.is_file() and normalized(entry.name) == normalized(basename)]
    if len(matches) > 1:
        raise ValueError("同一目录存在多个相似文件名，请提供准确路径：" + ", ".join(matches))
    return matches[0] if matches else None



def col_letter(col_idx_1based):
    s = ""
    n = col_idx_1based
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


_INT_HDR = re.compile(r"必须\s*整数|必须为整数")
_DEC_HDR = re.compile(r"最多\s*(\d+)\s*位小数")


def header_rules(headers):
    """从表头文字解析数值约束规则。"""
    rules = {}
    for i, h in enumerate(headers):
        if not isinstance(h, str):
            continue
        if _INT_HDR.search(h):
            rules[i] = {"type": "int", "header": h}
        m = _DEC_HDR.search(h)
        if m:
            rules[i] = {"type": "dec", "digits": int(m.group(1)), "header": h}
    return rules


def as_number(v):
    """Numbers, and numbers stored as text (very common after a CSV import), as float."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, str):
        text = v.strip().replace(",", "").replace("，", "").replace(" ", "")
        if not text:
            return None
        try:
            return float(text)
        except ValueError:
            return None
    return None


def check_value(rule, v):
    num = as_number(v)
    if num is None or not math.isfinite(num):
        return None
    if rule["type"] == "int":
        if abs(num - round(num)) > 1e-9:
            return f"要求整数，实际为 {v}（建议四舍五入为 {round(num)}）"
    else:
        s = format(Decimal(repr(float(num))), "f")
        frac = s.split(".")[1].rstrip("0") if "." in s else ""
        if len(frac) > rule["digits"]:
            return f"要求最多 {rule['digits']} 位小数，实际小数位 {len(frac)}（值 {v}）"
    return None


def cell_value(cell):
    if isinstance(cell, dict):
        return cell.get("value")
    return cell


def _header_text(cell):
    value = cell_value(cell)
    return value if isinstance(value, str) else ""


def detect_header(rows, max_scan=8):
    """The header is the first of the leading rows that carries the most constraint rules.

    Invoices usually put a title ("商业发票 COMMERCIAL INVOICE") on row 1, so assuming row 1
    silently disabled every rule. Falling back to row 1 keeps old behaviour when no row matches.
    """
    best_rules, best_index = 0, 0
    for index, row in enumerate(rows[:max_scan]):
        count = len(header_rules([_header_text(cell) for cell in row]))
        if count > best_rules:
            best_rules, best_index = count, index
    return best_index


def _md_cell(cell):
    if isinstance(cell, dict) and cell.get("formula") and cell.get("value") is None:
        text = f"(未计算) {cell['formula']}"
    else:
        value = cell_value(cell)
        text = "" if value is None else str(value)
    return text.replace("\n", "⏎").replace("|", "\\|")


def render_markdown(rows, header_index):
    lines = []
    width = max((len(r) for r in rows), default=0)
    for index, row in enumerate(rows):
        cells = [_md_cell(c) for c in row]
        cells += [""] * (width - len(cells))
        lines.append("| " + " | ".join(cells) + " |")
        if index == header_index:
            lines.append("|" + "---|" * width)
    return lines


def finish_sheet(result, name, rows, dims, row_count, col_count, non_empty, fmt, start_row=1, start_column=1):
    """Shared tail: locate the header, apply constraint rules, build the entry."""
    if rows:
        header_index = detect_header(rows)
        rules = header_rules([_header_text(cell) for cell in rows[header_index]])
        for offset, row in enumerate(rows[header_index + 1:], start=start_row + header_index + 1):
            for ci, rule in rules.items():
                if ci >= len(row):
                    continue
                raw = cell_value(row[ci])
                msg = check_value(rule, raw)
                if msg:
                    result["warnings"].append({
                        "sheet": name,
                        "cell": f"{col_letter(ci + start_column)}{offset}",
                        "header": rule["header"],
                        "value": raw,
                        "kind": "规则违规",
                        "reason": msg,
                    })
        for offset, row in enumerate(rows, start=start_row):
            for ci, cell in enumerate(row):
                if isinstance(cell, dict) and cell.get("formula") and cell.get("value") is None:
                    result["warnings"].append({
                        "sheet": name,
                        "cell": f"{col_letter(ci + start_column)}{offset}",
                        "header": "公式",
                        "value": cell["formula"],
                        "kind": "公式无缓存值",
                        "reason": "该公式没有被 Excel 计算过，文件里没有缓存结果，不能当作金额/数量使用；请用 Excel 打开保存一次，或按公式人工核对。",
                    })
    entry = {"name": name, "dims": dims, "rowCount": row_count, "colCount": col_count, "startRow": start_row, "startColumn": start_column}
    if len(non_empty) <= 500:
        entry["nonEmptyCells"] = non_empty
    entry["markdown" if fmt == "markdown" else "rows"] = (
        render_markdown(rows, detect_header(rows)) if fmt == "markdown" else rows
    )
    result["sheets"].append(entry)


def read_with_xlrd(real, fmt, want_comments, max_rows, start_row=1, start_column=1, max_columns=512, wanted_sheet=None):
    import xlrd
    try:
        wb = xlrd.open_workbook(real, formatting_info=True)
        has_fmt = True
    except Exception:
        wb = xlrd.open_workbook(real)
        has_fmt = False

    result = {"file": real, "engine": "xlrd", "format": fmt, "sheets": [], "warnings": []}

    if wanted_sheet and wanted_sheet not in wb.sheet_names():
        raise ValueError(f"找不到工作表：{wanted_sheet}")
    for sh in wb.sheets():
        name = sh.name
        if wanted_sheet and name != wanted_sheet:
            continue
        rows = []
        non_empty = {}
        note_map = getattr(sh, "cell_note_map", {}) or {}

        limit_r = min(sh.nrows, start_row - 1 + max_rows)
        for r0 in range(start_row - 1, limit_r):
            r = r0 + 1
            vals = []
            for c0 in range(start_column - 1, min(sh.ncols, start_column - 1 + max_columns)):
                cell = sh.cell(r0, c0)
                ctype = cell.ctype
                val = cell.value
                if ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
                    val = None
                elif ctype == xlrd.XL_CELL_TEXT:
                    val = val if val != "" else None
                elif ctype == xlrd.XL_CELL_NUMBER:
                    if isinstance(val, float) and val.is_integer():
                        val = int(val)
                elif ctype == xlrd.XL_CELL_DATE:
                    try:
                        val = xlrd.xldate_as_datetime(val, wb.datemode).isoformat(sep=" ")
                    except Exception:
                        pass
                elif ctype == xlrd.XL_CELL_BOOLEAN:
                    val = bool(val)
                elif ctype == xlrd.XL_CELL_ERROR:
                    val = xlrd.error_text_from_code.get(int(val), "#ERROR!")

                nf = None
                if has_fmt and cell.xf_index is not None and val is not None:
                    try:
                        xf = wb.xf_list[cell.xf_index]
                        fobj = wb.format_map.get(xf.format_key)
                        if fobj and fobj.format_str and fobj.format_str not in ("General", "@"):
                            nf = fobj.format_str
                    except Exception:
                        pass

                comment_txt = None
                if want_comments and (r0, c0) in note_map:
                    try:
                        comment_txt = str(note_map[(r0, c0)].text)[:500]
                    except Exception:
                        pass

                if val is not None:
                    non_empty[f"{col_letter(c0 + 1)}{r}"] = val

                if nf or comment_txt:
                    info = {"value": val}
                    if nf:
                        info["numberFormat"] = nf
                    if comment_txt:
                        info["comment"] = comment_txt
                    vals.append(info)
                else:
                    vals.append(val)
            rows.append(vals)

        dims = f"A1:{col_letter(sh.ncols)}{sh.nrows}" if sh.nrows and sh.ncols else "A1"
        finish_sheet(result, name, rows, dims, sh.nrows, sh.ncols, non_empty, fmt, start_row, start_column)
        result["sheets"][-1]["truncated"] = limit_r < sh.nrows or start_column - 1 + max_columns < sh.ncols
        if limit_r < sh.nrows:
            result["sheets"][-1]["nextRow"] = limit_r + 1
        if start_column - 1 + max_columns < sh.ncols:
            result["sheets"][-1]["nextColumn"] = start_column + max_columns

    return result


def read_with_openpyxl(real, fmt, want_formula, want_comments, max_rows, start_row=1, start_column=1, max_columns=512, wanted_sheet=None):
    import openpyxl
    result = {"file": real, "engine": "openpyxl", "format": fmt, "sheets": [], "warnings": []}
    wb = openpyxl.load_workbook(real, data_only=False, read_only=False)
    wbv = openpyxl.load_workbook(real, data_only=True, read_only=False)

    def cellval(c, cv):
        raw = c.value
        formula = raw if isinstance(raw, str) and raw.startswith("=") else None
        array_ref = None
        if c.data_type == "f" and not isinstance(raw, str):
            formula = getattr(raw, "text", None) or "=DATA_TABLE()"
            array_ref = getattr(raw, "ref", None)
        cached = cv if cv is not None else (None if formula else raw)
        v = {"value": cached}
        if array_ref:
            v["arrayFormulaRef"] = array_ref
        if formula:
            # A workbook written by a program (not opened in Excel) has no cached result.
            if cv is None:
                v["value"] = None
                v["uncached"] = True
            if want_formula or cv is None:
                v["formula"] = formula
        nf = getattr(c, "number_format", None)
        if nf and nf != "General":
            v["numberFormat"] = nf
        if want_comments and c.comment:
            v["comment"] = c.comment.text[:500]
        return v

    if wanted_sheet and wanted_sheet not in wb.sheetnames:
        raise ValueError(f"找不到工作表：{wanted_sheet}")
    for name in wb.sheetnames:
        if wanted_sheet and name != wanted_sheet:
            continue
        ws, wsv = wb[name], wbv[name]
        rows = []
        non_empty = {}
        meaningful = [c for c in ws._cells.values()
                      if (c.value is not None and c.value != "") or (want_comments and c.comment)]
        row_count = max((c.row for c in meaningful), default=0)
        col_count = max((c.column for c in meaningful), default=0)
        truncated = False
        source_dims = ws.dimensions
        read_cols = min(col_count, start_column - 1 + max_columns)
        if col_count > read_cols:
            result["warnings"].append({"sheet": name, "kind": "列数超限",
                                       "reason": "有值列超过本次列范围；可用 startColumn=nextColumn 继续读取。"})
        last_row = min(row_count, start_row - 1 + max_rows)
        for r in range(start_row, last_row + 1):
            row = (ws.cell(r, c) for c in range(start_column, read_cols + 1))
            rowv = (wsv.cell(r, c) for c in range(start_column, read_cols + 1))
            vals = []
            for ci0, (c, cv) in enumerate(zip(row, rowv)):
                info = cellval(c, cv.value)
                if info["value"] is not None and info["value"] != "":
                    non_empty[f"{col_letter(ci0 + start_column)}{r}"] = info["value"]
                if info.get("formula") is not None or info.get("uncached") or "numberFormat" in info or "comment" in info:
                    vals.append(info)
                else:
                    vals.append(info["value"])
            rows.append(vals)
        truncated = row_count > last_row or col_count > read_cols
        dims = f"A1:{col_letter(col_count)}{row_count}" if col_count and row_count else "A1"
        finish_sheet(result, name, rows, dims, row_count, col_count, non_empty, fmt, start_row, start_column)
        result["sheets"][-1].update(sourceDims=source_dims, truncated=truncated)
        if row_count > last_row:
            result["sheets"][-1]["nextRow"] = last_row + 1
        if col_count > read_cols:
            result["sheets"][-1]["nextColumn"] = read_cols + 1
    wb.close()
    wbv.close()

    return result


def main():
    try:
        params = _load_params()
    except Exception as e:
        out({"error": f"参数解析失败: {e}"}); return 1
    if not isinstance(params, dict):
        out({"error": "参数必须是 JSON 对象。"}); return 1
    path = params.get("path")
    if not isinstance(path, str) or not path.strip():
        out({"error": "缺少 path 参数"}); return 1
    try:
        real = find_file(path)
    except Exception as error:
        out({"error": str(error)}); return 1
    if not real:
        out({"error": f"文件不存在: {path}"}); return 1

    global REQUESTED_PATH
    REQUESTED_PATH = path
    fmt = params.get("format", "json")  # json | markdown
    want_formula = bool(params.get("formulas", True))
    want_comments = bool(params.get("comments", True))
    try:
        max_rows = max(1, int(params.get("maxRows", 500)))
    except Exception:
        max_rows = 500

    start_row = max(1, int(params.get("startRow") or 1))
    start_column = max(1, min(16384, int(params.get("startColumn") or 1)))
    max_columns = max(1, min(512, int(params.get("maxColumns") or 512)))
    max_rows = min(max_rows, 10000)
    extra = (start_row, start_column, max_columns, params.get("sheet"))
    ext = os.path.splitext(real)[1].lower()
    if ext == ".xls":
        try:
            out(read_with_xlrd(real, fmt, want_comments, max_rows, *extra))
            return 0
        except Exception as e_xls:
            # 万一扩展名是 .xls 但实际是 xlsx，尝试回退 openpyxl
            try:
                out(read_with_openpyxl(real, fmt, want_formula, want_comments, max_rows, *extra))
                return 0
            except Exception:
                out({"error": f"打开 .xls 失败: {e_xls}"}); return 1
    else:
        try:
            out(read_with_openpyxl(real, fmt, want_formula, want_comments, max_rows, *extra))
            return 0
        except Exception as e_xlsx:
            # 万一扩展名是 .xlsx 但实际是旧版 .xls，尝试回退 xlrd
            try:
                out(read_with_xlrd(real, fmt, want_comments, max_rows, *extra))
                return 0
            except Exception:
                out({"error": f"打开失败: {e_xlsx}"}); return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        out({"error": str(error)[:1000]})
        sys.exit(1)
