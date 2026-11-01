"""PDF reader: bounded JSON, content-addressed image cache and prefetch (1.2.4).

1.3.1: every file operation goes through fs_path(), so PDFs and page images whose full path is
260 characters or longer work without the LongPathsEnabled registry switch, and image/cache file
names carry a 16-character prefix of the image key (the full key stays in the metadata).

Scanned pages are whole-page images. Images have hard pixel/byte limits and each batch has
a separate data-URL budget. Cache entries depend on PDF contents, page and renderer settings;
private `_prefetchOnly` requests populate that cache without delivering images to the model.
"""
import hashlib
import json
import os
import re
import sys
import tempfile
import unicodedata
from contextlib import contextmanager

SCAN_TEXT_THRESHOLD = 20          # fewer visible characters than this = "no usable text layer"
IMAGE_HEAVY_COVERAGE = 0.6        # an image covering this share of a page that also has text
MAX_LONG_SIDE_PX = 2000           # per rendered image (page or tile); A4 text stays legible
MAX_IMAGE_BYTES = int(1.5 * 1024 * 1024)  # several pages per request stay far below relay limits
MAX_BATCH_ENCODED_BYTES = 6 * 1024 * 1024
JPEG_QUALITY = 85
IMAGE_DIR = "pdf_pages"
CACHE_VERSION = "1.2.4"
LONG_PATH_THRESHOLD = 200         # at or above this length a path uses the \\?\ namespace
FILE_KEY_CHARS = 16               # image key characters used in file names


def fs_path(path):
    r"""The name handed to the operating system for one file.

    Windows rejects ordinary paths of 260 characters or more (MAX_PATH) unless the registry's
    LongPathsEnabled switch is on; the \\?\ namespace has no such limit. A long absolute path is
    therefore passed in that form. Short paths are left exactly as they were. Results shown to the
    host and the model always use plain_path().
    """
    if os.name != "nt" or not path or path.startswith("\\\\?\\") or path.startswith("\\\\.\\"):
        return path
    absolute = os.path.abspath(path)
    if len(absolute) < LONG_PATH_THRESHOLD:
        return path
    if absolute.startswith("\\\\"):
        return "\\\\?\\UNC\\" + absolute[2:]
    return "\\\\?\\" + absolute


def plain_path(path):
    if path.startswith("\\\\?\\UNC\\"):
        return "\\\\" + path[8:]
    if path.startswith("\\\\?\\"):
        return path[4:]
    return path


def document_id(path):
    digest = hashlib.sha256()
    with open(fs_path(path), "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def encoded_image_bytes(size, extension):
    mime = "image/jpeg" if extension == "jpg" else "image/png"
    return len(f"data:{mime};base64,") + 4 * ((size + 2) // 3)


@contextmanager
def cache_file_lock(path):
    """Serialize short publications/reads; Windows cannot replace a file another writer holds."""
    descriptor = os.open(path + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
    locked = False
    try:
        if os.fstat(descriptor).st_size == 0:
            os.write(descriptor, b"\0")
        os.lseek(descriptor, 0, os.SEEK_SET)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(descriptor, msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(descriptor, fcntl.LOCK_EX)
        locked = True
        yield
    finally:
        if locked:
            os.lseek(descriptor, 0, os.SEEK_SET)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def atomic_write(path, data):
    """A separate temporary file per writer prevents concurrent render/prefetch collisions."""
    descriptor, temporary = tempfile.mkstemp(prefix=".pdf-", suffix=".tmp", dir=os.path.dirname(path))
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
        with cache_file_lock(path):
            # An identical cache entry is immutable, so a concurrent successful render never
            # replaces pixels the host might already be reading to form its next request.
            try:
                with open(path, "rb") as handle:
                    identical = handle.read(len(data) + 1) == data
            except FileNotFoundError:
                identical = False
            if not identical:
                os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def emit(value):
    sys.stdout.buffer.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def normalized(value):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", value)).casefold()


def find_file(path):
    requested = plain_path(os.path.abspath(path))
    if os.path.isfile(fs_path(requested)):
        return requested
    directory, basename = os.path.split(requested)
    if not os.path.isdir(fs_path(directory)):
        return None
    matches = [os.path.join(directory, entry.name) for entry in os.scandir(fs_path(directory))
               if entry.is_file() and normalized(entry.name) == normalized(basename)]
    if len(matches) > 1:
        raise ValueError("同一目录存在多个相似文件名，请提供准确路径：" + ", ".join(matches))
    return matches[0] if matches else None


def parse_pages(spec, count):
    if not spec:
        return list(range(1, count + 1))
    pages = []
    for part in str(spec).replace("，", ",").split(","):
        part = part.strip()
        if not part:
            continue
        match = re.fullmatch(r"(\d+)\s*(?:-\s*(\d*))?", part)
        if not match:
            raise ValueError(f"页码格式不正确：{part}，应写成 1-5 或 3,7,10-12")
        start = int(match.group(1))
        end = int(match.group(2)) if match.group(2) else (count if "-" in part else start)
        for page in range(max(1, start), min(count, end) + 1):
            if page not in pages:
                pages.append(page)
    if not pages:
        raise ValueError(f"所选页码不在 1-{count} 范围内。")
    return pages


def page_ranges(pages):
    groups = []
    for page in pages:
        if groups and page == groups[-1][-1] + 1:
            groups[-1].append(page)
        else:
            groups.append([page])
    return ",".join(str(g[0]) if len(g) == 1 else f"{g[0]}-{g[-1]}" for g in groups)


class PdfSource:
    """Text per page, plus (PyMuPDF only) page classification and rendering."""

    def __init__(self, path):
        self.document_id = document_id(path)
        try:
            try:
                import pymupdf as fitz
            except ImportError:
                import fitz
        except ImportError:
            fitz = None
        self.fitz = fitz
        if fitz is not None:
            self.document = fitz.open(fs_path(path))
            if self.document.needs_pass:
                self.document.close()
                raise ValueError("这个 PDF 有密码保护，无法读取。")
            self.engine, self.count = "pymupdf", self.document.page_count
            self.meta = self.document.metadata or {}
            self.reader = None
            return
        try:
            from pypdf import PdfReader
        except ImportError:
            raise ValueError("请安装 PDF 库：pip install pymupdf（推荐）或 pip install pypdf")
        self.document = None
        self.reader = PdfReader(fs_path(path))
        if self.reader.is_encrypted and not self.reader.decrypt(""):
            raise ValueError("这个 PDF 有密码保护，无法读取。")
        self.engine, self.count = "pypdf", len(self.reader.pages)
        self.meta = {key.lstrip("/").lower(): str(value) for key, value in (self.reader.metadata or {}).items()}

    @property
    def can_render(self):
        return self.document is not None

    def text(self, number):
        if self.document is not None:
            return self.document[number - 1].get_text("text")
        return self.reader.pages[number - 1].extract_text() or ""

    def image_coverage(self, number):
        """Share of the page covered by its largest placed image (0 when unknown)."""
        if self.document is None:
            try:
                resources = self.reader.pages[number - 1].get("/Resources") or {}
                xobjects = resources.get("/XObject") or {}
                return 1.0 if any(xobjects[key].get("/Subtype") == "/Image" for key in xobjects) else 0.0
            except Exception:
                return 0.0
        page = self.document[number - 1]
        area = abs(page.rect) or 1.0
        best = 0.0
        try:
            for info in page.get_image_info():
                bbox = self.fitz.Rect(info.get("bbox")) & page.rect
                if not bbox.is_empty:
                    best = max(best, abs(bbox) / area)
        except Exception:
            best = 1.0 if page.get_images() else 0.0
        return min(1.0, best)

    def render(self, number, tiles, dpi, folder, stem=None):
        """Return cached pixels before asking MuPDF to render; each metadata file is atomic."""
        page = self.document[number - 1]
        rect = page.rect
        records = []
        overlap = rect.height * 0.02 if tiles > 1 else 0
        for tile in range(1, tiles + 1):
            parameters = {"version": CACHE_VERSION, "renderer": getattr(self.fitz, "VersionBind", "unknown"),
                          "dpi": dpi, "tiles": tiles, "tile": tile, "longSidePx": MAX_LONG_SIDE_PX,
                          "maxImageBytes": MAX_IMAGE_BYTES, "jpegQuality": JPEG_QUALITY}
            identity = {"documentId": self.document_id, "page": number, "parameters": parameters}
            image_key = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
            file_key = image_key[:FILE_KEY_CHARS]
            cache_path = fs_path(os.path.join(folder, f"cache_{file_key}.json"))
            label = f"PDF 第 {number} 页" + (f"（第 {tile}/{tiles} 块，自上而下，相邻块有少量重叠）" if tiles > 1 else "")
            cached = self.cached_image(cache_path, identity, image_key, folder)
            if cached is not None:
                records.append(dict(cached, label=label, cacheHit=True))
                continue
            top = rect.y0 + rect.height * (tile - 1) / tiles - overlap
            bottom = rect.y0 + rect.height * tile / tiles + overlap
            clip = self.fitz.Rect(rect.x0, max(rect.y0, top), rect.x1, min(rect.y1, bottom))
            long_side_pt = max(clip.width, clip.height) or 1
            # Matrix permits sub-72 dpi for unusually large PDF pages. Leave a rounding margin,
            # then check the actual pixmap dimensions instead of trusting an estimated DPI.
            scale = min(dpi / 72, (MAX_LONG_SIDE_PX - 2) / long_side_pt)
            data, ext, width, height = None, "jpg", 0, 0
            for _ in range(20):
                pix = page.get_pixmap(matrix=self.fitz.Matrix(scale, scale), clip=clip, alpha=False)
                width, height = pix.width, pix.height
                if max(width, height) > MAX_LONG_SIDE_PX:
                    scale *= (MAX_LONG_SIDE_PX - 2) / max(width, height)
                    continue
                png = pix.tobytes("png")
                for quality in (JPEG_QUALITY, 70, 55):
                    data, ext = pix.tobytes("jpeg", jpg_quality=quality), "jpg"
                    if len(png) < len(data):
                        data, ext = png, "png"
                    if len(data) <= MAX_IMAGE_BYTES:
                        break
                if data is not None and len(data) <= MAX_IMAGE_BYTES:
                    break
                scale *= 0.8
            if data is None or len(data) > MAX_IMAGE_BYTES or max(width, height) > MAX_LONG_SIDE_PX:
                raise ValueError("本页图片无法压缩到 2000 像素及 1.5 MiB 的硬上限内。")
            filename = f"pdf_{file_key}_p{number}.{ext}"
            target = fs_path(os.path.join(folder, filename))
            atomic_write(target, data)
            record = {"path": os.path.join(IMAGE_DIR, filename), "page": number, "tile": tile, "tiles": tiles,
                      "documentId": self.document_id, "imageKey": image_key,
                      "width": width, "height": height, "dpi": round(scale * 72, 3),
                      "bytes": len(data), "encodedBytes": encoded_image_bytes(len(data), ext)}
            metadata = dict(identity, imageKey=image_key, image=record, sha256=hashlib.sha256(data).hexdigest())
            atomic_write(cache_path, json.dumps(metadata, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            records.append(dict(record, label=label, cacheHit=False))
        return records

    @staticmethod
    def cached_image(cache_path, identity, image_key, folder):
        try:
            with cache_file_lock(cache_path):
                with open(cache_path, "r", encoding="utf-8") as handle:
                    metadata = json.load(handle)
            if any(metadata.get(key) != value for key, value in identity.items()) or metadata.get("imageKey") != image_key:
                return None
            image = metadata["image"]
            extension = os.path.splitext(image["path"])[1].lstrip(".")
            filename = f"pdf_{image_key[:FILE_KEY_CHARS]}_p{identity['page']}.{extension}"
            if extension not in ("jpg", "png") or image["path"] != os.path.join(IMAGE_DIR, filename):
                return None
            if (image.get("documentId") != identity["documentId"] or image.get("imageKey") != image_key
                    or image.get("page") != identity["page"]
                    or not 0 < image["width"] <= MAX_LONG_SIDE_PX or not 0 < image["height"] <= MAX_LONG_SIDE_PX):
                return None
            image_path = fs_path(os.path.join(folder, filename))
            with cache_file_lock(image_path):
                with open(image_path, "rb") as handle:
                    data = handle.read(MAX_IMAGE_BYTES + 1)
            if (not 0 < len(data) <= MAX_IMAGE_BYTES or len(data) != image["bytes"]
                    or encoded_image_bytes(len(data), extension) != image["encodedBytes"]
                    or hashlib.sha256(data).hexdigest() != metadata.get("sha256")):
                return None
            return image
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def close(self):
        if self.document is not None:
            self.document.close()


def json_text_bytes(text):
    return len(json.dumps(text, ensure_ascii=False).encode("utf-8")) - 2


def bounded_prefix(text, chars, byte_budget):
    low, high = 0, min(len(text), chars)
    while low < high:
        middle = (low + high + 1) // 2
        if json_text_bytes(text[:middle]) <= byte_budget:
            low = middle
        else:
            high = middle - 1
    return text[:low]


def bounded_int(args, key, default, low, high):
    value = args.get(key)
    if value is None or value == "":
        return default
    try:
        return max(low, min(high, int(value)))
    except (TypeError, ValueError):
        raise ValueError(f"{key} 必须是整数。")


def main():
    raw = sys.stdin.buffer.read()
    args = None
    for encoding in ("utf-8-sig", "gbk", "utf-16"):
        try:
            args = json.loads(raw.decode(encoding) or "{}")
            break
        except (ValueError, UnicodeError):
            continue
    if not isinstance(args, dict):
        raise ValueError("参数必须是有效的 JSON 对象。")
    requested = args.get("path")
    if not isinstance(requested, str) or not requested.strip():
        raise ValueError("缺少 path 参数。")
    path = find_file(requested)
    if not path:
        raise ValueError(f"找不到文件：{os.path.abspath(requested)}；只在指定目录匹配文件名。")
    max_chars = max(1000, min(200000, int(args.get("maxChars") or 60000)))
    start_offset = max(0, int(args.get("charOffset") or 0))
    keyword = args.get("search") or ""
    if not isinstance(keyword, str):
        raise ValueError("search 必须是文本。")
    keyword = keyword.strip()
    vision = str(args.get("vision") or "auto").strip().lower()
    if vision not in ("auto", "force", "off"):
        raise ValueError("vision 只能是 auto、force 或 off。")
    dpi = bounded_int(args, "dpi", 200, 72, 300)
    tiles = 1  # 1.2.3 r4: a page is always one whole image, never split into strips
    max_images = bounded_int(args, "maxImages", 4, 1, 6)
    prefetch_only = args.get("_prefetchOnly") is True

    source = PdfSource(path)
    try:
        info = {"path": path, "engine": source.engine, "pageCount": source.count, "bytes": os.path.getsize(fs_path(path)),
                "documentId": source.document_id, "prefetchSupported": True,
                "title": str(source.meta.get("title") or "")[:1000] or None,
                "author": str(source.meta.get("author") or "")[:1000] or None}
        if plain_path(os.path.abspath(requested)) != path:
            info.update(requestedPath=os.path.abspath(requested), pathResolved=True,
                        pathResolutionNote="使用了指定目录中唯一的相似文件名，实际路径见 path。")
        if args.get("info") is True:
            emit(info)
            return
        pages = parse_pages(args.get("pages"), source.count)
        folder = None
        images, scanned, visual, image_heavy, blank, unsearched = [], [], [], [], [], []
        render_errors = []
        chunks, read = [], []
        used, used_bytes = 0, 0
        next_page = next_offset = None
        partial_page = None
        image_budget_stop = False
        render_failed_stop = False
        image_encoded_bytes = 0
        match_count = 0

        for index, number in enumerate(pages):
            text = re.sub(r"[ \t]+\n", "\n", source.text(number)).strip()
            visible = len(re.sub(r"\s+", "", text))
            coverage = source.image_coverage(number) if visible < SCAN_TEXT_THRESHOLD or vision != "off" else 0.0
            is_scan = visible < SCAN_TEXT_THRESHOLD and coverage > 0
            if is_scan:
                scanned.append(number)
            elif visible < SCAN_TEXT_THRESHOLD:
                blank.append(number)
            elif coverage >= IMAGE_HEAVY_COVERAGE:
                image_heavy.append(number)
            # Searching never renders by itself: a keyword cannot be matched inside a picture.
            wants_image = vision == "force" or (vision == "auto" and is_scan and not keyword)
            page_images = []
            if wants_image and source.can_render:
                if len(images) + tiles > max_images:
                    if read:
                        next_page, image_budget_stop = number, True
                        break
                    raise ValueError(f"maxImages={max_images} 太小。")
                if folder is None:
                    folder = os.path.join(os.getcwd(), IMAGE_DIR)
                    os.makedirs(fs_path(folder), exist_ok=True)
                try:
                    page_images = source.render(number, tiles, dpi, folder)
                except Exception as error:
                    render_errors.append({"page": number, "error": str(error)[:300]})
                    # A failed scan is not a read page: let the host resume precisely here.
                    next_page, render_failed_stop = number, True
                    break
                encoded_bytes = sum(image["encodedBytes"] for image in page_images)
                if image_encoded_bytes + encoded_bytes > MAX_BATCH_ENCODED_BYTES:
                    next_page, image_budget_stop = number, True
                    break
            if keyword:
                if is_scan:
                    unsearched.append(number)
                lower, needle = text.lower(), keyword.lower()
                snippets, start = [], 0
                while len(snippets) < 5:
                    hit = lower.find(needle, start)
                    if hit < 0:
                        break
                    snippets.append(text[max(0, hit - 200):hit + len(keyword) + 200].replace("\n", " "))
                    start = hit + len(needle)
                if snippets:
                    match_count += 1
                elif not page_images:
                    read.append(number)
                    continue
                body = "\n…\n".join(snippets)
            else:
                body = text
            offset = min(start_offset, len(body)) if index == 0 else 0
            if page_images:
                files = "、".join(image["path"].replace("\\", "/") for image in page_images)
                kind = "扫描页，无文字层" if is_scan else "按要求转为图片"
                delivery = "图片已缓存，尚未发送" if prefetch_only else "图片已交给视觉模型"
                header = f"--- 第 {number} 页（{kind}；{delivery}：{files}）---\n"
            elif is_scan:
                reason = "当前引擎无法渲染（需安装 PyMuPDF）" if not source.can_render else \
                    ("vision=off" if vision == "off" else "搜索模式不转图片")
                header = f"--- 第 {number} 页（扫描页，无文字层；未转图片：{reason}）---\n"
            else:
                header = f"--- 第 {number} 页 ---\n"
            block = header + body[offset:]
            separator = "\n\n" if chunks else ""
            extra_bytes = json_text_bytes(separator + block)
            if used + len(separator) + len(block) > max_chars or used_bytes + extra_bytes > 340000:
                if chunks:
                    next_page = number
                    break
                cut = bounded_prefix(block, max_chars, 340000)
                consumed = max(0, len(cut) - len(header))
                chunks.append(cut)
                read.append(number)
                images.extend(page_images)
                image_encoded_bytes += sum(image["encodedBytes"] for image in page_images)
                if page_images:
                    visual.append(number)
                if offset + consumed < len(body):
                    next_page, next_offset, partial_page = number, offset + consumed, number
                elif index + 1 < len(pages):
                    next_page = pages[index + 1]
                break
            chunks.append(block)
            read.append(number)
            images.extend(page_images)
            image_encoded_bytes += sum(image["encodedBytes"] for image in page_images)
            if page_images:
                visual.append(number)
            used += len(separator) + len(block)
            used_bytes += extra_bytes

        result = dict(info, pagesRead=page_ranges(read), pagesReadList=read,
                      text="" if prefetch_only else "\n\n".join(chunks), truncated=next_page is not None,
                      batchEncodedBytes=image_encoded_bytes, batchEncodedByteLimit=MAX_BATCH_ENCODED_BYTES)
        if prefetch_only:
            result["prefetchOnly"] = True
        if keyword:
            result.update(search=keyword, matches=match_count)
        notes = []
        if next_page is not None:
            result["nextPage"] = next_page
            if next_offset is not None:
                result.update(nextCharOffset=next_offset, partialPage=partial_page,
                              offsetKind="searchSnippets" if keyword else "pageText")
                # 1.3.3: the rest of the original selection, not an open-ended "N-".
                remaining = page_ranges([number for number in pages if number >= next_page]) or str(next_page)
                result["nextPages"] = remaining
                notes.append(f"继续读取用 pages=\"{remaining}\"、charOffset={next_offset}，并保留原 search 参数。")
            elif image_budget_stop:
                action = "缓存" if prefetch_only else "交出"
                notes.append(f"本次已{action} {len(images)} 张图片（maxImages={max_images}，编码后总量不超过 6 MiB）；"
                             f"从第 {next_page} 页继续读取，即可得到后续扫描页的图片。")
            elif render_failed_stop:
                notes.append(f"第 {next_page} 页渲染失败，未计入已读页面；修复错误后从本页重试。")
            else:
                notes.append(f"内容已在字符或输出字节上限处停止；从第 {next_page} 页继续读取。")
        if scanned:
            result["scannedPages"] = page_ranges(scanned)
        if images:
            if prefetch_only:
                result["prefetchedImages"] = images
                result["prefetchedPages"] = page_ranges(visual)
                notes.append("这些图片只在本地预渲染缓存，未发送给视觉模型，也未标记为已提取记录。")
            else:
                result["images"] = images
                result["visionPages"] = page_ranges(visual)
                notes.append(f"第 {page_ranges(visual)} 页已转为图片，随本轮作为图片交给视觉模型，请直接看图读取。"
                             "图片内容不是精确文字：金额、数量、箱号、提单号等需逐字核对，看不清处要明确说明，不要猜测。"
                             "看图后用 record_pdf_pages 提交每页的 page、text、fields（以及 documentId）；"
                             "text 记录本任务需要的原文，fields 记录编号、金额、数量、重量、日期、签章等关键字段；"
                             "尚未读清的页不要提交为已提取。设 continue=true 可在同一次记录调用中自动得到下一批，"
                             "无需先另发选页请求。只有提交记录后，旧图才可从后续请求中移除；"
                             "需要逐字复核时用本工具指定 pages 并设 review=true，程序会复用本地缓存图片。")
        if image_heavy:
            result["imageHeavyPages"] = page_ranges(image_heavy)
            notes.append(f"第 {page_ranges(image_heavy)} 页有文字层但大部分是图片（可能含印章、签名、手写或扫描内容），"
                         "需要看原貌时用 pages 指定该页并设 vision=\"force\"。")
        if blank:
            result["blankPages"] = page_ranges(blank)
        if unsearched:
            result["unsearchedScannedPages"] = page_ranges(unsearched)
            notes.append(f"第 {page_ranges(unsearched)} 页是扫描页，文字搜索无法覆盖；请不带 search 读取这些页，以图片方式查看。")
        if scanned and not source.can_render and vision != "off":
            notes.append("这些扫描页需要 PyMuPDF 才能转成图片：pip install pymupdf。")
        if render_errors:
            result["renderErrors"] = render_errors
        if notes:
            result["note"] = " ".join(notes)
        emit(result)
    finally:
        source.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"error": f"无法读取 PDF：{str(error)[:1000]}"})
        sys.exit(1)
