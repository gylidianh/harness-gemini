"""PDF layout and red seal inspection, with resumable bounded JSON (1.2.1)."""
import contextlib
import json
import math
import os
import re
import sys
import unicodedata
from collections import deque


def out(value):
    sys.stdout.buffer.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


LONG_PATH_THRESHOLD = 200         # at or above this length a path uses the \\?\ namespace


def fs_path(path):
    """The name handed to the operating system for one file (1.3.3, same as read_pdf.py).

    Windows rejects ordinary paths of 260 characters or more unless LongPathsEnabled is on; the
    long-path namespace has no such limit. Short paths are left exactly as they were.
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


def page_ranges(numbers):
    """1.3.3: the remaining selection as a page string ("2-3,5"), never an open-ended "N-"."""
    numbers = sorted(set(numbers))
    parts = []
    start = previous = None
    for number in numbers:
        if start is None:
            start = previous = number
        elif number == previous + 1:
            previous = number
        else:
            parts.append(str(start) if start == previous else f"{start}-{previous}")
            start = previous = number
    if start is not None:
        parts.append(str(start) if start == previous else f"{start}-{previous}")
    return ",".join(parts)


def normalized(value):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", value)).casefold()


def find_file(path):
    requested = plain_path(os.path.abspath(path))
    if os.path.isfile(fs_path(requested)):
        return requested
    directory, basename = os.path.split(requested)
    if not os.path.isdir(fs_path(directory)):
        return None
    matches = [os.path.join(directory, e.name) for e in os.scandir(fs_path(directory)) if e.is_file() and normalized(e.name) == normalized(basename)]
    if len(matches) > 1:
        raise ValueError("同一目录存在多个相似文件名，请提供准确路径：" + ", ".join(matches))
    return matches[0] if matches else None


MIN_RED_PIXELS = 300
MIN_REGION_SHARE = 0.00005
MIN_ASPECT = 0.25
MAX_ASPECT = 4.0
MIN_REGION_DENSITY = 0.02


def analyse_red(module, pix):
    """Separate spatial red components; counts and boxes use original image units."""
    if pix.colorspace is None:
        return None
    if pix.colorspace.n != 3:
        pix = module.Pixmap(module.csRGB, pix)
    if pix.alpha:
        pix = module.Pixmap(pix, 0)
    width, height, channels = pix.width, pix.height, pix.n
    if not width or not height or channels < 3:
        return None
    samples = pix.samples
    step = max(1, math.ceil(math.sqrt(width * height / 400000)))
    reds = set()
    total_red = 0
    for gy, y in enumerate(range(0, height, step)):
        for gx, x in enumerate(range(0, width, step)):
            i = (y * width + x) * channels
            r, g, b = samples[i:i + 3]
            if r > 90 and r - g > 40 and r - b > 40:
                reds.add((gx, gy))
                total_red += min(step, width - x) * min(step, height - y)
    remaining = set(reds)
    regions = []
    # A two-sample gap joins broken stamp ink without merging a distant red heading.
    neighbours = [(dx, dy) for dx in range(-2, 3) for dy in range(-2, 3) if dx or dy]
    while remaining:
        first = remaining.pop()
        queue = deque([first])
        min_x = max_x = first[0]
        min_y = max_y = first[1]
        count = 0
        while queue:
            gx, gy = queue.popleft()
            count += min(step, width - gx * step) * min(step, height - gy * step)
            min_x, max_x = min(min_x, gx), max(max_x, gx)
            min_y, max_y = min(min_y, gy), max(max_y, gy)
            for dx, dy in neighbours:
                other = (gx + dx, gy + dy)
                if other in remaining:
                    remaining.remove(other)
                    queue.append(other)
        x0, y0 = min_x * step, min_y * step
        x1, y1 = min(width, (max_x + 1) * step), min(height, (max_y + 1) * step)
        area = (x1 - x0) * (y1 - y0)
        aspect = (x1 - x0) / (y1 - y0)
        density = min(1, count / area)
        likely = (count >= MIN_RED_PIXELS and area >= width * height * MIN_REGION_SHARE
                  and MIN_ASPECT <= aspect <= MAX_ASPECT and density >= MIN_REGION_DENSITY)
        regions.append({"redPixelCount": count, "redBBox": [x0, y0, x1, y1],
                        "redRegionAspect": round(aspect, 3), "redRegionDensity": round(density, 4),
                        "likelyRedSeal": likely})
    regions.sort(key=lambda r: (r["likelyRedSeal"], r["redPixelCount"]), reverse=True)
    best = regions[0] if regions else {"redPixelCount": 0, "redBBox": None,
                                     "redRegionAspect": 0, "redRegionDensity": 0, "likelyRedSeal": False}
    return dict(best, redPixelRatio=round(total_red / (width * height), 5),
                totalRedPixelCount=total_red, samplingStep=step, redRegions=regions[:50],
                redRegionsTruncated=len(regions) > 50, likelyRedSeal=any(r["likelyRedSeal"] for r in regions))


def text_lines(page, module, positions=False):
    # Span origins are baselines. Top edges move when fonts differ on the same line.
    flags = module.TEXTFLAGS_DICT & ~module.TEXT_PRESERVE_IMAGES
    spans = [s for b in page.get_text("dict", flags=flags)["blocks"] if b.get("type") == 0
             for line in b.get("lines", []) for s in line.get("spans", []) if s.get("text")]
    groups = []
    for span in sorted(spans, key=lambda s: (s["origin"][1], s["bbox"][0])):
        baseline = span["origin"][1]
        if groups and abs(groups[-1][0] - baseline) <= 2:
            groups[-1][1].append(span)
        else:
            groups.append((baseline, [span]))
    result = []
    for baseline, group in groups:
        group.sort(key=lambda s: s["bbox"][0])
        entry = {"y": round(min(s["bbox"][1] for s in group), 1),
                 "baseline": round(baseline, 1),
                 "x0": round(min(s["bbox"][0] for s in group), 1),
                 "x1": round(max(s["bbox"][2] for s in group), 1),
                 "text": "  ".join(s["text"] for s in group)}
        if positions:
            entry["wordXs"] = [{"x": round(s["bbox"][0], 1), "w": s["text"]} for s in group]
        result.append(entry)
    return result


def is_red(color):
    return color and len(color) >= 3 and color[0] > 0.6 and color[0] - max(color[1:3]) > 0.2


def inspect_page(doc, pno, module, positions):
    page = doc[pno]
    p = {"page": pno + 1, "pageSize": [round(page.rect.width, 1), round(page.rect.height, 1)],
         "textLines": text_lines(page, module, positions), "tables": [], "images": [], "redVectorRegions": []}
    words = page.get_text("words")
    try:
        with contextlib.redirect_stdout(sys.stderr):
            p["tables"] = [{"bbox": [round(v, 1) for v in t.bbox], "rows": t.extract()} for t in page.find_tables()]
    except Exception:
        pass
    for image in page.get_image_info(xrefs=True):
        xref = image.get("xref", 0)
        entry = {"bbox": [round(v, 1) for v in image["bbox"]], "width": image["width"],
                 "height": image["height"], "xref": xref}
        rect = module.Rect(image["bbox"])
        entry["textNearby"] = " ".join(w[4] for w in words
                                      if module.Rect(w[:4]).intersects(rect + (-30, -30, 30, 30)))[:200]
        try:
            pix = module.Pixmap(doc, xref) if xref else page.get_pixmap(clip=rect)
            entry.update(analyse_red(module, pix) or {})
        except Exception as error:
            entry["redAnalysisError"] = str(error)[:200]
        entry.setdefault("likelyRedSeal", False)
        p["images"].append(entry)
    try:
        drawings = [d for d in page.get_drawings() if is_red(d.get("fill")) or is_red(d.get("color"))]
        p["redVectorObjects"] = len(drawings)
        boxes = []
        for drawing in drawings:
            box = module.Rect(drawing["rect"])
            # Merge intersecting parts of the same vector stamp.
            changed = True
            while changed:
                changed = False
                for i, other in enumerate(boxes):
                    if (box + (-3, -3, 3, 3)).intersects(other):
                        box |= other
                        boxes.pop(i)
                        changed = True
                        break
            boxes.append(box)
        for box in boxes:
            if box.height <= 0 or box.width <= 0 or not MIN_ASPECT <= box.width / box.height <= MAX_ASPECT:
                continue
            clip = (box + (-2, -2, 2, 2)) & page.rect
            detail = analyse_red(module, page.get_pixmap(matrix=module.Matrix(2, 2), clip=clip))
            if detail and detail["likelyRedSeal"]:
                p["redVectorRegions"].append({"bbox": [round(v, 1) for v in box], "source": "vector",
                                             "likelyRedSeal": True, "redPixelCount": detail["redPixelCount"]})
    except Exception as error:
        p["vectorAnalysisError"] = str(error)[:200]
    return p


def records(page):
    for key in ("textLines", "tables", "images", "redVectorRegions"):
        for value in page[key]:
            if key == "tables":
                for start in range(0, len(value["rows"]), 20):
                    yield key, dict(value, rowStart=start, rows=value["rows"][start:start + 20])
            else:
                yield key, value


def main():
    raw = sys.stdin.buffer.read()
    params = None
    for encoding in ("utf-8-sig", "gbk", "utf-16"):
        try:
            params = json.loads(raw.decode(encoding) or "{}")
            break
        except (ValueError, UnicodeError):
            continue
    if not isinstance(params, dict):
        raise ValueError("参数必须是有效的 JSON 对象。")
    requested = params.get("path")
    if not isinstance(requested, str) or not requested.strip():
        raise ValueError("缺少 path 参数。")
    path = find_file(requested)
    if not path:
        raise ValueError(f"文件不存在：{requested}；只在指定目录匹配文件名。")
    try:
        import pymupdf as module
    except ImportError:
        import fitz as module
    with module.open(fs_path(path)) as doc:
        if doc.needs_pass:
            raise ValueError("这个 PDF 有密码保护，无法读取。")
        selected = set()
        if params.get("pages"):
            for part in str(params["pages"]).replace("，", ",").split(","):
                match = re.fullmatch(r"\s*(\d+)\s*(?:-\s*(\d*))?\s*", part)
                if not match:
                    raise ValueError(f"页码格式不正确：{part}")
                first = int(match[1])
                last = int(match[2]) if match[2] else (doc.page_count if "-" in part else first)
                selected.update(range(max(1, first), min(doc.page_count, last) + 1))
        else:
            selected.update(range(1, doc.page_count + 1))
        if not selected:
            raise ValueError("所选页码不在文档范围内。")
        result = {"file": path, "pageCount": doc.page_count, "pages": [], "truncated": False}
        if plain_path(os.path.abspath(requested)) != path:
            result.update(requestedPath=plain_path(os.path.abspath(requested)), pathResolved=True,
                          pathResolutionNote="使用了指定目录中唯一的相似文件名，实际路径见 file。")
        byte_size = lambda value: len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        max_pages = max(1, min(100, int(params.get("maxPages") or 10)))
        offset = max(0, int(params.get("pageOffset") or 0))
        for number in sorted(selected):
            if len(result["pages"]) >= max_pages:
                result.update(truncated=True, nextPage=number, nextPageOffset=0)
                break
            full = inspect_page(doc, number - 1, module, params.get("includeWordPositions") is True)
            page = {k: v for k, v in full.items() if k not in ("textLines", "tables", "images", "redVectorRegions")}
            page.update(textLines=[], tables=[], images=[], redVectorRegions=[])
            result["pages"].append(page)
            items = list(records(full))
            for index in range(offset, len(items)):
                key, value = items[index]
                if byte_size(value) > 280000:
                    value = {"oversizeRecord": True, "recordOffset": index,
                             "note": "此条版面记录超出输出上限；请用 read_pdf 按字符续读文本。"}
                page[key].append(value)
                if byte_size(result) > 310000:
                    page[key].pop()
                    result.update(truncated=True, nextPage=number, nextPageOffset=index)
                    break
            if result["truncated"]:
                break
            offset = 0
        seals = []
        for page in result["pages"]:
            for image in page["images"]:
                for region in image.get("redRegions", []):
                    if region.get("likelyRedSeal"):
                        image_box = image["bbox"]
                        rb = region["redBBox"]
                        bbox = [round(image_box[0] + rb[0] / image["width"] * (image_box[2] - image_box[0]), 1),
                                round(image_box[1] + rb[1] / image["height"] * (image_box[3] - image_box[1]), 1),
                                round(image_box[0] + rb[2] / image["width"] * (image_box[2] - image_box[0]), 1),
                                round(image_box[1] + rb[3] / image["height"] * (image_box[3] - image_box[1]), 1)]
                        seals.append({"page": page["page"], "source": "image", "xref": image.get("xref"), "bbox": bbox})
            seals.extend({"page": page["page"], "source": "vector", "bbox": r["bbox"]}
                         for r in page["redVectorRegions"] if r.get("likelyRedSeal"))
        # Leave room for a bounded summary even on documents with thousands of red objects.
        result["sealSummary"] = {"likelyRedSealCount": len(seals), "likelyRedSeals": seals[:100],
                                 "summaryListTruncated": len(seals) > 100,
                                 "note": "仅汇总本次返回记录中的疑似红章。颜色检测是启发式判断，请结合页面截图复核。"}
        if result["truncated"]:
            # 1.3.3: the hint keeps the rest of the original selection. "N-" used to drop its upper
            # bound and any gaps, so following it read pages that were never asked for.
            remaining = page_ranges(number for number in selected if number >= result["nextPage"])
            result["nextPages"] = remaining
            result["note"] = f"继续用 pages=\"{remaining}\"、pageOffset={result['nextPageOffset']} 读取。"
        out(result)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        out({"error": f"无法检查 PDF：{str(error)[:1000]}"})
        sys.exit(1)

