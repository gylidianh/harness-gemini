#!/usr/bin/env python
"""read_doc: 稳健地批量读取/转换旧版 Word 97-2003 (.doc/.dot/.rtf) 文件。JSON stdin -> JSON stdout

解决的问题：
1. 不依赖 pywin32 (win32com)：Word COM 调用放在独立的 PowerShell 工作脚本里完成。
2. 不拼接 PowerShell -Command 字符串：所有参数写入 UTF-8 JSON 作业文件，再用 -File 调用，
   彻底避免 "$word" 被提前展开成 if ()、"$f:" 被当成驱动器/作用域前缀等语法问题。
3. 一个文件 = 一个独立 WINWORD 进程：每个文件单独启动并退出 Word，单文件超时会被强制结束，
   崩溃(0x800706BA RPC 不可用 / 0x800A01A8 / Null 对象)不会连锁影响后续文件；失败自动以
   OpenAndRepair 重试；文件之间有间隔。
4. Word 不可用或多次失败时，自动退回内置纯 Python 解析器（自带 OLE 复合文档 + Word 97 piece table
   解析，不需要 olefile/antiword），至少提取正文文字。
5. 转换得到的 .docx 用 python-docx 按正文顺序提取段落与表格（二维数组），全文另存 .txt / .json。
"""
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import unicodedata


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

SKILL_DIR = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.join(SKILL_DIR, "word_worker.ps1")
LEGACY_EXT = {".doc", ".dot", ".rtf", ".wps"}
READ_EXT = LEGACY_EXT | {".docx", ".docm", ".dotx"}
OUTPUT_BUDGET = 330_000  # 字符，留余量给 JSON 结构（应用上限约 400 KB）
CREATE_NO_WINDOW = 0x08000000


def host_timeout_s():
    """宿主按 skill.json 的 timeoutMs 直接结束本脚本，届时尚未输出的结果全部丢失。"""
    try:
        with open(os.path.join(SKILL_DIR, "skill.json"), encoding="utf-8-sig") as f:
            value = json.load(f).get("timeoutMs", 60000)
        if isinstance(value, int) and not isinstance(value, bool):
            return max(1000, min(value, 600000)) / 1000.0
    except Exception:
        pass
    return 600.0


def time_plan(t_start, host_s):
    """所有阻塞步骤（Word 尝试、超时清理、重试间隔、文件间隔、收尾）都必须在 hard 之前结束。"""
    margin = min(25.0, max(3.0, host_s * 0.05))   # Python 启动、生成并输出 JSON
    tail = min(15.0, max(2.0, host_s * 0.03))     # 最后的自动化进程清点与汇总
    return {
        "hostSeconds": host_s,
        "hard": t_start + host_s - margin,
        "work": t_start + host_s - margin - tail,
        "extract": min(10.0, max(2.0, host_s * 0.02)),     # 单个文件转换后的提取和写文件
        "cleanup": min(30.0, max(4.0, host_s * 0.05)),     # Word 超时后的强制结束与清理
        "minAttempt": min(15.0, max(5.0, host_s * 0.025)),  # 少于此秒数不值得启动 Word
    }


# ----------------------------------------------------------------------------- IO
def read_args():
    raw = sys.stdin.buffer.read()
    if not raw.strip():
        return {}
    for enc in ("utf-8-sig", "utf-16", "gbk"):
        try:
            return json.loads(raw.decode(enc))
        except Exception:
            continue
    raise ValueError("无法解析标准输入中的 JSON 参数")


def emit(obj, code=0):
    # Harness caps stdout by UTF-8 bytes. Keep oversized reports on disk before
    # shortening inline fields, so a Chinese batch never produces broken JSON.
    encode = lambda value: json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    data = encode(obj)
    if len(data) > 380000:
        output_dir = obj.get("summary", {}).get("outputDir") if isinstance(obj, dict) else None
        if not output_dir or not os.path.isdir(output_dir):
            data = encode({"error": "结果超过宿主输出字节上限，请缩小本次读取范围。"})
        else:
            result_file = os.path.join(output_dir, f"read_doc-result-{os.getpid()}-{time.time_ns()}.json")
            with open(result_file, "xb") as handle:
                handle.write(data)
            obj["fullResultFile"] = result_file
            obj["reportTruncated"] = True
            obj["outputNote"] = "达到宿主字节上限，部分内联内容已省略；完整报告见 fullResultFile，全文和表格见各文件路径。"
            for record in obj.get("files", []):
                for field in ("tables", "textBoxes", "headersFooters"):
                    record.pop(field, None)
            data = encode(obj)
            while len(data) > 370000:
                texts = [record for record in obj.get("files", []) if isinstance(record.get("text"), str) and record["text"]]
                if not texts:
                    break
                record = max(texts, key=lambda value: len(value["text"]))
                record["text"] = record["text"][:len(record["text"]) // 2]
                record["textTruncated"] = True
                data = encode(obj)
            omitted = 0
            while len(data) > 370000 and obj.get("files"):
                obj["files"].pop()
                omitted += 1
                obj["omittedFileRecords"] = omitted
                data = encode(obj)
            if len(data) > 380000:
                obj = {"reportTruncated": True, "fullResultFile": result_file,
                       "summary": {"total": obj.get("summary", {}).get("total"),
                                   "succeeded": obj.get("summary", {}).get("succeeded")},
                       "outputNote": "报告元数据超出宿主上限，完整结果已保存到 fullResultFile。"}
                data = encode(obj)
    sys.stdout.buffer.write(data)
    sys.stdout.flush()
    sys.exit(code)


# ----------------------------------------------------------------------------- 路径（NBSP / 特殊空格）
_SPACE_RE = re.compile(r"[\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000\ufeff\s]+")


def _norm_name(s):
    return _SPACE_RE.sub(" ", unicodedata.normalize("NFC", s)).strip().casefold()


def resolve_path(p, base):
    """按组件逐级匹配，兼容 NBSP / 全角空格 / 多个空格；不递归搜索其它目录。"""
    p = os.path.expandvars(os.path.expanduser(str(p).strip().strip('"')))
    if not os.path.isabs(p):
        p = os.path.join(base, p)
    p = os.path.normpath(p)
    if os.path.exists(p):
        return p, None
    drive, rest = os.path.splitdrive(p)
    parts = [x for x in re.split(r"[\\/]+", rest) if x]
    cur = drive + os.sep if drive else os.sep
    for part in parts:
        cand = os.path.join(cur, part)
        if os.path.exists(cand):
            cur = cand
            continue
        try:
            entries = os.listdir(cur)
        except OSError:
            return None, f"目录不可读: {cur}"
        target = _norm_name(part)
        hits = [e for e in entries if _norm_name(e) == target]
        if len(hits) == 1:
            cur = os.path.join(cur, hits[0])
        elif len(hits) > 1:
            return None, f"在 {cur} 中有多个与 '{part}' 相似的名称: {hits}"
        else:
            return None, f"找不到: {os.path.join(cur, part)}"
    return cur, None


# ----------------------------------------------------------------------------- 文件类型嗅探
def sniff(path):
    try:
        with open(path, "rb") as f:
            head = f.read(16)
    except OSError as e:
        return "unreadable:" + str(e)
    if head.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
        return "ole"
    if head.startswith(b"PK\x03\x04"):
        return "zip"
    if head.lstrip(b"\xef\xbb\xbf").startswith(b"{\\rtf"):
        return "rtf"
    low = head.lower()
    if low.lstrip().startswith((b"<html", b"<!doc", b"<?xml", b"mime")):
        return "html/xml"
    return "unknown"


# ----------------------------------------------------------------------------- 内置 OLE + Word97 解析（兜底）
class CFB:
    FREESECT, ENDOFCHAIN = 0xFFFFFFFF, 0xFFFFFFFE

    def __init__(self, data):
        if data[:8] != b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
            raise ValueError("不是 OLE 复合文档")
        self.d = data
        self.ss = 1 << struct.unpack_from("<H", data, 0x1E)[0]
        self.mss = 1 << struct.unpack_from("<H", data, 0x20)[0]
        n_fat, first_dir = struct.unpack_from("<II", data, 0x2C)
        self.cutoff = struct.unpack_from("<I", data, 0x38)[0]
        first_mf, n_mf, first_difat, n_difat = struct.unpack_from("<IIII", data, 0x3C)
        difat = list(struct.unpack_from("<109I", data, 0x4C))
        s, guard = first_difat, 0
        while s not in (self.FREESECT, self.ENDOFCHAIN) and guard < 100000:
            vals = struct.unpack_from(f"<{self.ss // 4}I", self._sec(s))
            difat.extend(vals[:-1])
            s = vals[-1]
            guard += 1
        fat = []
        for sec in difat[:n_fat]:
            if sec in (self.FREESECT, self.ENDOFCHAIN):
                continue
            fat.extend(struct.unpack_from(f"<{self.ss // 4}I", self._sec(sec)))
        self.fat = fat
        dirdata = self._chain(first_dir)
        self.entries = []
        for i in range(len(dirdata) // 128):
            e = dirdata[i * 128:(i + 1) * 128]
            nl = struct.unpack_from("<H", e, 64)[0]
            name = e[:max(nl - 2, 0)].decode("utf-16-le", "replace")
            typ = e[66]
            start, size = struct.unpack_from("<IQ", e, 116)
            if self.ss == 512:
                size &= 0xFFFFFFFF
            self.entries.append((name, typ, start, size))
        root = self.entries[0]
        self.ministream = self._chain(root[2])[:root[3]] if root[3] else b""
        self.minifat = []
        if n_mf and first_mf != self.ENDOFCHAIN:
            mf = self._chain(first_mf)
            self.minifat = list(struct.unpack_from(f"<{len(mf) // 4}I", mf))

    def _sec(self, n):
        off = (n + 1) * self.ss
        return self.d[off:off + self.ss]

    def _chain(self, start):
        out, s, seen = [], start, set()
        while s not in (self.FREESECT, self.ENDOFCHAIN) and s < len(self.fat) and s not in seen:
            seen.add(s)
            out.append(self._sec(s))
            s = self.fat[s]
        return b"".join(out)

    def stream(self, name):
        for n, typ, start, size in self.entries:
            if typ == 2 and n.lower() == name.lower():
                if size < self.cutoff:
                    out, s, seen = [], start, set()
                    while s not in (self.FREESECT, self.ENDOFCHAIN) and s < len(self.minifat) and s not in seen:
                        seen.add(s)
                        out.append(self.ministream[s * self.mss:(s + 1) * self.mss])
                        s = self.minifat[s]
                    return b"".join(out)[:size]
                return self._chain(start)[:size]
        return None

    def names(self):
        return [e[0] for e in self.entries if e[1] == 2]


def builtin_doc_text(path):
    """纯 Python 提取 Word 97-2003 正文文字（不含版式；表格单元格以制表符分隔）。"""
    with open(path, "rb") as f:
        data = f.read()
    cfb = CFB(data)
    wd = cfb.stream("WordDocument")
    if wd is None:
        raise ValueError(f"OLE 文件中没有 WordDocument 流（可能是 Excel/其它 Office 文件）：{cfb.names()[:10]}")
    ident, nfib = struct.unpack_from("<HH", wd, 0)
    if ident != 0xA5EC:
        raise ValueError("WordDocument 流标识不正确")
    flags = struct.unpack_from("<H", wd, 0x0A)[0]
    if flags & 0x0100:
        raise ValueError("文档已加密/受密码保护，内置解析器无法读取")
    if nfib < 0x00C1:
        raise ValueError(f"Word 6/95 等更早格式 (nFib=0x{nfib:04X})，内置解析器不支持，请用 Word 转换")
    table = cfb.stream("1Table" if flags & 0x0200 else "0Table")
    if table is None:
        raise ValueError("缺少 Table 流")
    pos = 32
    csw = struct.unpack_from("<H", wd, pos)[0]; pos += 2 + csw * 2
    cslw = struct.unpack_from("<H", wd, pos)[0]
    lw = pos + 2
    ccp = struct.unpack_from("<8i", wd, lw + 12)  # ccpText, Ftn, Hdd, Mcr(Atn), Edn, Txbx, HdrTxbx
    pos = lw + cslw * 4
    pos += 2  # cbRgFcLcb
    fc_clx, lcb_clx = struct.unpack_from("<II", wd, pos + 33 * 8)
    clx = table[fc_clx:fc_clx + lcb_clx]
    i = 0
    while i < len(clx) and clx[i] == 0x01:
        i += 3 + struct.unpack_from("<h", clx, i + 1)[0]
    if i >= len(clx) or clx[i] != 0x02:
        raise ValueError("无法定位 piece table (Pcdt)")
    lcb = struct.unpack_from("<I", clx, i + 1)[0]
    plc = clx[i + 5:i + 5 + lcb]
    n = (lcb - 4) // 12
    cps = struct.unpack_from(f"<{n + 1}I", plc)
    parts = []
    for k in range(n):
        pcd = plc[(n + 1) * 4 + k * 8:(n + 1) * 4 + (k + 1) * 8]
        fc = struct.unpack_from("<I", pcd, 2)[0]
        cnt = cps[k + 1] - cps[k]
        if fc & 0x40000000:
            off = (fc & 0x3FFFFFFF) // 2
            parts.append(wd[off:off + cnt].decode("cp1252", "replace"))
        else:
            parts.append(wd[fc:fc + cnt * 2].decode("utf-16-le", "replace"))
    full = "".join(parts)
    main_len = max(ccp[0], 0)
    main = full[:main_len] if main_len else full
    rest = full[main_len:]
    return clean_word_text(main), clean_word_text(rest), f"0x{nfib:04X}"


def clean_word_text(t):
    out, depth_skip = [], []
    for ch in t:
        o = ord(ch)
        if o == 0x13:          # 域开始：跳过域代码，保留域结果
            depth_skip.append(True); continue
        if o == 0x14:
            if depth_skip: depth_skip[-1] = False
            continue
        if o == 0x15:
            if depth_skip: depth_skip.pop()
            continue
        if depth_skip and depth_skip[-1]:
            continue
        if ch == "\r" or o == 0x0B: out.append("\n")
        elif o == 0x07: out.append("\t")          # 单元格/行结束标记
        elif o == 0x0C: out.append("\n\f\n")
        elif o == 0x1E: out.append("-")
        elif o in (0x1F, 0x01, 0x08, 0x02, 0x05, 0x00): continue
        elif ch == "\u00a0": out.append(" ")
        else: out.append(ch)
    s = "".join(out)
    s = re.sub(r"\t\t\n?", "\n", s)  # 行尾 "单元格结束+行结束" 合并为换行
    s = re.sub(r"[ \t]+\n", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def ole_precheck(path):
    """返回 None 表示结构正常；否则返回问题描述。用于避免把明显损坏的文件交给 Word 白等超时。"""
    try:
        with open(path, "rb") as f:
            cfb = CFB(f.read())
        wd = cfb.stream("WordDocument")
        if wd is None:
            return "OLE 文件中没有 WordDocument 流（可能不是 Word 文档）"
        if len(wd) < 0x200 or struct.unpack_from("<H", wd, 0)[0] != 0xA5EC:
            return "WordDocument 流头部无效"
        return None
    except Exception as e:
        return f"OLE 复合文档结构无法解析（{type(e).__name__}: {e}）"


# ----------------------------------------------------------------------------- python-docx 提取
def extract_docx(path, include_tables=True):
    import docx  # python-docx
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    from docx.oxml.ns import qn

    d = docx.Document(path)
    lines, tables = [], []
    for el in d.element.body.iterchildren():
        if el.tag == qn("w:p"):
            lines.append(Paragraph(el, d).text)
        elif el.tag == qn("w:tbl"):
            t = Table(el, d)
            grid = []
            for row in t.rows:
                vals, last = [], None
                try:
                    cells = row.cells
                except Exception:
                    cells = []
                for c in cells:
                    if last is not None and c._tc is last:
                        continue  # 横向合并单元格去重
                    last = c._tc
                    vals.append(c.text.strip())
                grid.append(vals)
            ti = len(tables) + 1
            tables.append(grid)
            lines.append(f"[表格 {ti}]")
            for r in grid:
                lines.append("| " + " | ".join(v.replace("\n", " / ") for v in r) + " |")
            lines.append(f"[/表格 {ti}]")
    # 文本框（python-docx 的 paragraph.text 不含文本框内容）
    tb = []
    for txbx in d.element.body.iter(qn("w:txbxContent")):
        s = "\n".join("".join(x.text or "" for x in p.iter(qn("w:t"))) for p in txbx.iter(qn("w:p"))).strip()
        if s and s not in tb:
            tb.append(s)
    # 页眉页脚
    hf, seen = [], set()
    for sec in d.sections:
        for part in (sec.header, sec.footer, sec.first_page_header, sec.first_page_footer):
            try:
                if part.is_linked_to_previous and hf:
                    continue
                s = "\n".join(p.text for p in part.paragraphs).strip()
                for t in part.tables:
                    for r in t.rows:
                        s += "\n" + " | ".join(c.text.strip() for c in r.cells)
                s = s.strip()
                if s and s not in seen:
                    seen.add(s); hf.append(s)
            except Exception:
                pass
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    cp = d.core_properties
    meta = {k: str(getattr(cp, k)) for k in ("title", "author", "last_modified_by", "created", "modified")
            if getattr(cp, k, None)}
    return {
        "text": text,
        "tables": tables if include_tables else None,
        "tableCount": len(tables),
        "textBoxes": tb,
        "headersFooters": hf,
        "metadata": meta,
        "inlineImages": len(d.inline_shapes),
    }


# ----------------------------------------------------------------------------- Word COM（隔离进程）
def _kill_pid(pid, timeout=15):
    try:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True,
                       creationflags=CREATE_NO_WINDOW, timeout=timeout)
    except Exception:
        pass


def word_convert_one(src, dst_docx, dst_pdf, repair, timeout_s, tmp, hard_deadline=None):
    def left(cap):
        # 超时后的结束与清理同样不能越过 hard_deadline，否则宿主会直接结束整个调用
        if hard_deadline is None:
            return cap
        return max(1.0, min(cap, hard_deadline - time.time()))

    job_id = f"{os.getpid()}_{int(time.time() * 1000)}"
    ext = os.path.splitext(src)[1].lower() or ".doc"
    # 复制为 ASCII 临时文件：规避长路径/特殊字符/网络下载标记(Zone.Identifier)/源文件被占用
    tsrc = os.path.join(tmp, f"in_{job_id}{ext}")
    shutil.copyfile(src, tsrc)
    tdocx = os.path.join(tmp, f"out_{job_id}.docx")
    tpdf = os.path.join(tmp, f"out_{job_id}.pdf") if dst_pdf else None
    job = {
        "src": tsrc, "dst": tdocx, "pdfDst": tpdf, "repair": bool(repair),
        "resultFile": os.path.join(tmp, f"res_{job_id}.json"),
        "pidFile": os.path.join(tmp, f"pid_{job_id}.txt"),
    }
    job_file = os.path.join(tmp, f"job_{job_id}.json")
    with open(job_file, "w", encoding="utf-8") as f:
        json.dump(job, f, ensure_ascii=False)
    cmd = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
           "-File", WORKER, "-JobFile", job_file]
    t0 = time.time()
    timed_out = False
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            creationflags=CREATE_NO_WINDOW)
    try:
        _, err = proc.communicate(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        timed_out = True
        _kill_pid(proc.pid, timeout=left(15))
        try:
            _, err = proc.communicate(timeout=left(10))
        except Exception:
            err = b""
            try:
                proc.kill()
            except Exception:
                pass
    # Word/WPS 由 DCOM 启动、不是 PowerShell 的子进程：超时后让 worker 以 cleanup 模式
    # 只结束本任务自己启动并记录下 PID 的那一个 Word/WPS 进程（1.3.5）；其它会话、Outlook、
    # ERP 等程序同时启动的自动化进程一概不碰。没能识别出自己的进程时什么也不结束。
    killed = []
    identified = False
    if timed_out:
        try:
            cp = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                                 "-File", WORKER, "-JobFile", job_file, "-Mode", "cleanup"],
                                capture_output=True, creationflags=CREATE_NO_WINDOW, timeout=left(40))
            cleanup = json.loads(cp.stdout.decode("utf-8", "replace").strip() or "{}")
            killed = cleanup.get("killed") or []
            if isinstance(killed, int):
                killed = [killed]
            identified = cleanup.get("identified") is True
        except Exception:
            pass
    res = {}
    try:
        with open(job["resultFile"], encoding="utf-8-sig") as f:
            res = json.load(f)
    except Exception:
        res = {"ok": False, "error": "工作进程未写出结果" + ("（超时被强制结束）" if timed_out else "")}
    if timed_out:
        res["ok"] = False
        if killed:
            res["error"] = f"Word 处理超过 {timeout_s}s，已强制结束本次启动的 Word/WPS 进程 {killed}"
        elif identified:
            res["error"] = f"Word 处理超过 {timeout_s}s；本次启动的 Word/WPS 进程已退出"
        else:
            res["error"] = (f"Word 处理超过 {timeout_s}s；未能识别本次启动的 Word/WPS 进程，"
                            "为避免误伤其它程序未结束任何进程，如有残留请在任务管理器中手动结束")
    stderr = (err or b"").decode("utf-8", "replace").strip()
    if not stderr:
        try:
            stderr = (err or b"").decode("gbk", "replace").strip()
        except Exception:
            pass
    if stderr and not res.get("error"):
        res["stderr"] = stderr[-1500:]
    if res.get("ok") and os.path.exists(tdocx):
        os.makedirs(os.path.dirname(dst_docx), exist_ok=True)
        shutil.move(tdocx, dst_docx)
        if tpdf and os.path.exists(tpdf):
            shutil.move(tpdf, dst_pdf)
        else:
            res["pdf"] = False
    res["seconds"] = round(time.time() - t0, 1)
    for p in (tsrc, tdocx, tpdf, job_file, job["resultFile"], job["pidFile"]):
        if p and os.path.exists(p):
            try: os.remove(p)
            except OSError: pass
    return res


FATAL_COM = ("80040154", "class not registered", "没有注册类", "未注册")


def explain(err):
    e = (err or "").lower().strip()
    if not e:
        return None
    if "800706ba" in e or "rpc" in e:
        return "WINWORD 进程崩溃/退出 (RPC 不可用)"
    if "800a01a8" in e:
        return "对象已失效 (Word 已崩溃后的连锁错误)"
    if "password" in e or "密码" in e or "800a1520" in e:
        return "文档受密码保护"
    if any(k in e for k in FATAL_COM):
        return "本机未安装/未注册 Word COM"
    if "800a1066" in e or "800a175d" in e or "could not open" in e or "无法打开" in e:
        return "Word 无法打开该文件（损坏或格式不受支持）"
    if "超过" in e or "timeout" in e:
        return "Word 卡死超时"
    return None


# ----------------------------------------------------------------------------- 主流程
def collect(args, base):
    files, errors = [], []
    targets = []
    if args.get("files"):
        fl = args["files"]
        targets.extend([fl] if isinstance(fl, str) else list(fl))
    if args.get("path"):
        targets.append(args["path"])
    if not targets:
        raise ValueError("请提供 path（文件或文件夹）或 files（文件列表）")
    recursive = bool(args.get("recursive", False))
    include_docx = bool(args.get("includeDocx", False))
    allowed = READ_EXT if include_docx else LEGACY_EXT
    for t in targets:
        p, err = resolve_path(t, base)
        if err:
            errors.append({"input": t, "error": err}); continue
        if os.path.isdir(p):
            walker = os.walk(p) if recursive else [(p, [], os.listdir(p))]
            for root, _, names in walker:
                for n in sorted(names):
                    if n.startswith("~$"):
                        continue  # Word 锁文件
                    if os.path.splitext(n)[1].lower() in allowed:
                        files.append(os.path.join(root, n))
        else:
            files.append(p)
    seen, uniq = set(), []
    for f in files:
        k = os.path.normcase(os.path.abspath(f))
        if k not in seen:
            seen.add(k); uniq.append(f)
    return uniq, errors


def main():
    t_start = time.time()
    args = read_args()
    base = os.environ.get("HARNESS_WORKSPACE") or os.getcwd()
    mode = (args.get("mode") or "auto").lower()          # auto | word | builtin
    export_pdf = bool(args.get("exportPdf", False))
    overwrite = bool(args.get("overwrite", False))
    extract = args.get("extract", True) is not False
    include_tables = args.get("includeTables", True) is not False
    max_chars = int(args.get("maxCharsPerFile", 15000))
    retries = max(0, min(int(args.get("retries", 2)), 4))
    timeout_s = max(15, min(int(args.get("timeoutPerFileSec", 90)), 300))
    delay = max(0.0, min(float(args.get("delayBetweenFilesSec", 1.0)), 10.0))
    budget_s = max(30, min(int(args.get("totalTimeBudgetSec", 540)), 580))

    files, input_errors = collect(args, base)
    out_dir_arg = args.get("outputDir")
    if out_dir_arg:
        out_dir = os.path.normpath(out_dir_arg if os.path.isabs(out_dir_arg) else os.path.join(base, out_dir_arg))
    else:
        out_dir = os.path.join(base, "doc_converted")
    os.makedirs(out_dir, exist_ok=True)

    tmp = tempfile.mkdtemp(prefix="read_doc_")
    word_ok = mode != "builtin"
    word_disabled_reason = None
    results, stems = [], {}
    chars_used = 0
    not_processed = []
    stop_reason = None
    plan = time_plan(t_start, host_timeout_s())

    for idx, src in enumerate(files):
        now = time.time()
        if now - t_start > budget_s:
            stop_reason = "totalTimeBudgetSec"
        elif now > plan["work"] - plan["extract"]:
            stop_reason = "hostTimeout"
        if stop_reason:
            not_processed = files[idx:]
            break
        name = os.path.basename(src)
        stem = os.path.splitext(name)[0]
        key = stem.casefold()
        stems[key] = stems.get(key, 0) + 1
        if stems[key] > 1:
            stem = f"{stem}__{stems[key]}"
        ext = os.path.splitext(name)[1].lower()
        r = {"source": src, "sizeBytes": os.path.getsize(src) if os.path.exists(src) else None,
             "detectedFormat": sniff(src), "warnings": []}
        dst_docx = os.path.join(out_dir, stem + ".docx")
        dst_pdf = os.path.join(out_dir, stem + ".pdf") if export_pdf else None
        docx_path = None

        if ext in (".docx", ".docm", ".dotx") or r["detectedFormat"] == "zip":
            if ext not in (".docx", ".docm", ".dotx"):
                r["warnings"].append("扩展名为旧格式但实际是 OOXML(zip)，已直接按 .docx 读取")
                shutil.copyfile(src, dst_docx)
                docx_path = dst_docx
            else:
                docx_path = src
            r["method"] = "python-docx(direct)"
        else:
            reuse = (not overwrite and os.path.exists(dst_docx)
                     and os.path.getmtime(dst_docx) >= os.path.getmtime(src)
                     and (not export_pdf or os.path.exists(dst_pdf)))
            if reuse:
                docx_path = dst_docx
                r["method"] = "reuse-existing-docx"
                r["warnings"].append("目标 .docx 已存在且比源文件新，直接复用（overwrite=true 可强制重转）")
            elif word_ok:
                attempts = []
                tries = retries + 1
                file_timeout = timeout_s
                if r["detectedFormat"] == "ole":
                    pre = ole_precheck(src)
                    if pre:
                        r["precheck"] = pre
                        r["warnings"].append("OLE 结构预检失败，只让 Word 尝试一次（缩短超时）：" + pre)
                        tries, file_timeout = 1, min(timeout_s, 30)
                deferred = False
                for a in range(tries):
                    # 本次尝试连同超时清理、之后的提取都必须放进宿主时限，放不下就缩短或不再尝试
                    room = plan["work"] - plan["extract"] - plan["cleanup"] - time.time()
                    attempt_timeout = int(min(file_timeout, room))
                    if attempt_timeout < plan["minAttempt"]:
                        if not attempts:
                            deferred = True
                        else:
                            r["warnings"].append(f"剩余时间不足（宿主上限 {plan['hostSeconds']:g}s），"
                                                 f"未进行第 {a + 1} 次及以后的 Word 尝试")
                        break
                    if attempt_timeout < file_timeout:
                        r["warnings"].append(f"剩余时间不足，第 {a + 1} 次 Word 尝试的超时由 {file_timeout}s "
                                             f"缩短为 {attempt_timeout}s")
                    res = word_convert_one(src, dst_docx, dst_pdf, repair=(a > 0 or bool(r.get("precheck"))),
                                           timeout_s=attempt_timeout, tmp=tmp,
                                           hard_deadline=time.time() + attempt_timeout + plan["cleanup"])
                    used_repair = a > 0 or bool(r.get("precheck"))
                    reason = explain(f'{res.get("error") or ""} {res.get("hresult") or ""}' if not res.get("ok") else None)
                    attempts.append({k: v for k, v in {
                        "attempt": a + 1, "openAndRepair": used_repair, "ok": res.get("ok"),
                        "error": res.get("error"), "hresult": res.get("hresult"), "diagnosis": reason,
                        "seconds": res.get("seconds"), "engine": res.get("engine"), "wordVersion": res.get("wordVersion"),
                        "stderr": res.get("stderr")}.items() if v not in (None, "")})
                    if res.get("ok"):
                        docx_path = dst_docx
                        r["method"] = "word-com(isolated)"
                        if res.get("engine"):
                            r["engine"] = f'{res.get("engine")} {res.get("wordVersion") or ""}'.strip()
                        if export_pdf:
                            r["pdf"] = dst_pdf if os.path.exists(dst_pdf) else None
                            if not r["pdf"]:
                                r["warnings"].append("PDF 导出失败（.docx 已成功）")
                        break
                    if reason == "本机未安装/未注册 Word COM":
                        word_ok = False
                        word_disabled_reason = res.get("error")
                        break
                    if reason == "文档受密码保护":
                        break
                    if a < tries - 1:  # 崩溃后给系统回收 WINWORD 的时间
                        time.sleep(max(0.0, min(2.0 + a * 2, 6.0, plan["work"] - time.time())))
                if deferred:
                    # 一次完整的 Word 尝试已放不进宿主时限：本文件和其后的文件留给下次调用
                    stop_reason = "hostTimeout"
                    not_processed = files[idx:]
                    break
                if len(attempts) > 1 or not docx_path:
                    r["wordAttempts"] = attempts
                if mode == "word" and not docx_path:
                    r["error"] = "Word 转换失败（mode=word，不使用内置解析兜底）"
            if not docx_path and mode != "word":
                # 兜底：内置解析器
                if r["detectedFormat"] == "ole":
                    try:
                        main_text, other, nfib = builtin_doc_text(src)
                        r["method"] = "builtin-ole-parser(text only)"
                        r["nFib"] = nfib
                        r["warnings"].append("未生成 .docx：内置解析器只提取纯文字，表格单元格以制表符分隔、无版式/印章信息")
                        txt = main_text + (("\n\n===== 页眉页脚/脚注/文本框等 =====\n" + other) if other else "")
                        r["_text"] = txt
                    except Exception as e:
                        msg = str(e)
                        if isinstance(e, (IndexError, struct.error)):
                            msg = f"文件结构损坏或被截断（{type(e).__name__}: {e}）"
                        r["error"] = f"内置解析失败: {msg}"
                elif r["detectedFormat"] == "rtf":
                    try:
                        r["_text"] = rtf_to_text(src)
                        r["method"] = "builtin-rtf(text only)"
                    except Exception as e:
                        r["error"] = f"RTF 解析失败: {e}"
                elif r["detectedFormat"] == "html/xml":
                    raw = open(src, "rb").read().decode("utf-8", "replace")
                    r["_text"] = re.sub(r"\s+\n", "\n", re.sub(r"<[^>]+>", " ", raw)).strip()
                    r["method"] = "builtin-html-strip(text only)"
                    r["warnings"].append("文件实际为 HTML/XML（常见于网页另存的 .doc）")
                else:
                    r.setdefault("error", f"无法识别的文件格式: {r['detectedFormat']}")

        if docx_path and docx_path != src:
            r["docx"] = docx_path
        # ---- 提取内容 ----
        content = None
        if extract and docx_path:
            try:
                content = extract_docx(docx_path, include_tables)
            except Exception as e:
                r["error"] = f"python-docx 读取失败: {e}"
        elif extract and r.get("_text") is not None:
            content = {"text": r["_text"], "tables": None, "tableCount": None}
        r.pop("_text", None)
        if content is not None:
            full = content["text"]
            txt_path = os.path.join(out_dir, stem + ".txt")
            with open(txt_path, "w", encoding="utf-8") as f:
                f.write(full)
                if content.get("headersFooters"):
                    f.write("\n\n===== 页眉/页脚 =====\n" + "\n---\n".join(content["headersFooters"]))
                if content.get("textBoxes"):
                    f.write("\n\n===== 文本框 =====\n" + "\n---\n".join(content["textBoxes"]))
            r["textFile"] = txt_path
            if content.get("tables"):
                tj = os.path.join(out_dir, stem + ".tables.json")
                with open(tj, "w", encoding="utf-8") as f:
                    json.dump(content["tables"], f, ensure_ascii=False, indent=1)
                r["tablesFile"] = tj
            r["charCount"] = len(full)
            allow = max(0, min(max_chars, OUTPUT_BUDGET - chars_used))
            r["text"] = full[:allow]
            r["textTruncated"] = len(full) > allow
            if r["textTruncated"]:
                r["warnings"].append(f"正文已截断为 {allow} 字符，完整内容见 textFile")
            chars_used += len(r["text"])
            for k in ("tableCount", "textBoxes", "headersFooters", "metadata", "inlineImages"):
                if content.get(k) not in (None, [], {}):
                    r[k] = content[k]
            # 表格已以 Markdown 形式内嵌在 text 中；只在剩余预算充足时额外给出二维数组
            if content.get("tables") and include_tables:
                tjson = json.dumps(content["tables"], ensure_ascii=False)
                if chars_used + len(tjson) < OUTPUT_BUDGET and not r["textTruncated"]:
                    r["tables"] = content["tables"]
                    chars_used += len(tjson)
                else:
                    r["warnings"].append("表格二维数组未内联返回（输出预算），见 tablesFile")
        if not r["warnings"]:
            r.pop("warnings")
        results.append(r)
        if idx < len(files) - 1 and r.get("method", "").startswith("word-com"):
            time.sleep(max(0.0, min(delay, plan["work"] - time.time())))

    shutil.rmtree(tmp, ignore_errors=True)
    lingering = []
    list_timeout = min(40.0, plan["hard"] - time.time())
    if list_timeout >= 2 and any(r.get("method", "").startswith("word-com") or r.get("wordAttempts") for r in results):
        try:
            out = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                                  "-File", WORKER, "-Mode", "list"],
                                 capture_output=True, creationflags=CREATE_NO_WINDOW, timeout=list_timeout)
            lingering = json.loads(out.stdout.decode("utf-8", "replace").strip() or "{}").get("automationPids") or []
            if isinstance(lingering, int):
                lingering = [lingering]
        except Exception:
            pass

    ok = [r for r in results if not r.get("error")]
    summary = {
        "total": len(files),
        "succeeded": len(ok),
        "failed": [{"source": r["source"], "error": r.get("error"),
                    "diagnosis": next((a.get("diagnosis") for a in reversed(r.get("wordAttempts", [])) if a.get("diagnosis")), None)}
                   for r in results if r.get("error")],
        "byMethod": {},
        "outputDir": out_dir,
        "seconds": round(time.time() - t_start, 1),
    }
    for r in results:
        m = r.get("method", "none")
        summary["byMethod"][m] = summary["byMethod"].get(m, 0) + 1
    if word_disabled_reason:
        summary["wordComUnavailable"] = word_disabled_reason
    if lingering:
        summary["automationProcessesStillRunning"] = lingering
        summary["automationNote"] = "仍有 Word/WPS 自动化进程（可能是其它程序启动的），本技能只清理自己启动的进程"
    if not_processed:
        summary["notProcessed"] = not_processed
        summary["stopReason"] = stop_reason
        if stop_reason == "hostTimeout":
            summary["continueHint"] = (f"剩余时间不足以在宿主 {plan['hostSeconds']:g} 秒上限内安全处理下一个文件，已提前停止；"
                                       "把 notProcessed 作为 files 再次调用即可继续")
        else:
            summary["continueHint"] = "已达到时间预算；把 notProcessed 作为 files 再次调用即可继续"
    if input_errors:
        summary["inputErrors"] = input_errors
    emit({"summary": summary, "files": results}, 0 if ok or not files else 1)


def rtf_to_text(path):
    raw = open(path, "rb").read().decode("latin-1")
    out, i, n, skip_depth, depth = [], 0, len(raw), None, 0
    uc_skip, pending_bytes = 1, bytearray()
    codepage = "gbk"
    m = re.search(r"\\ansicpg(\d+)", raw)
    if m:
        codepage = "cp" + m.group(1)

    def flush():
        if pending_bytes:
            try: out.append(pending_bytes.decode(codepage, "replace"))
            except LookupError: out.append(pending_bytes.decode("gbk", "replace"))
            pending_bytes.clear()

    dests = {"fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "header", "footer",
             "listtable", "listoverridetable", "rsidtbl", "generator", "themedata", "colorschememapping",
             "latentstyles", "datastore", "xmlnstbl", "fldinst", "*"}
    while i < n:
        c = raw[i]
        if c == "{":
            flush(); depth += 1; i += 1
        elif c == "}":
            flush()
            if skip_depth is not None and depth <= skip_depth:
                skip_depth = None
            depth -= 1; i += 1
        elif c == "\\":
            m = re.match(r"\\([a-zA-Z]+)(-?\d+)? ?|\\'([0-9a-fA-F]{2})|\\(.)", raw[i:i + 40], re.S)
            if not m:
                i += 1; continue
            i += m.end()
            if skip_depth is not None:
                continue
            if m.group(3):
                pending_bytes.append(int(m.group(3), 16)); continue
            flush()
            word, arg, sym = m.group(1), m.group(2), m.group(4)
            if sym:
                if sym == "*": skip_depth = depth
                elif sym in "\\{}": out.append(sym)
                elif sym == "~": out.append(" ")
                continue
            if word in dests:
                skip_depth = depth
            elif word in ("par", "line", "row"): out.append("\n")
            elif word in ("tab", "cell"): out.append("\t")
            elif word == "uc": uc_skip = int(arg or 1)
            elif word == "u":
                v = int(arg); out.append(chr(v + 65536 if v < 0 else v))
                k = 0
                while k < uc_skip and i < n:
                    if raw[i] == "\\" and raw[i + 1:i + 2] == "'": i += 4
                    else: i += 1
                    k += 1
        elif c in "\r\n":
            i += 1
        else:
            if skip_depth is None:
                flush(); out.append(c)
            i += 1
    flush()
    return re.sub(r"\n{3,}", "\n\n", "".join(out)).strip()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        import traceback
        emit({"error": str(e), "traceback": traceback.format_exc()[-3000:]}, 1)
