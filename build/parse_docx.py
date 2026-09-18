#!/usr/bin/env python3
"""Конвертер книги из Word (.docx) в JSON для сайта.

Использование:
    python3 build/parse_docx.py книга.docx site/data ID "Название" "Подзаголовок"

Почему не pandoc и не python-docx: в исходном файле «Философия» стили
Heading1/Heading2/Heading3 в styles.xml объявлены дважды (проверено —
задваивание не в тексте, а в самом XML стилей). Из-за этого готовые
конвертеры либо путают уровни заголовков, либо теряют иерархию целиком.
Здесь document.xml читается напрямую через ElementTree, без прослойки,
которая могла бы наступить на ту же коллизию styleId.
"""
import argparse
import json
import re
import shutil
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
WP = "{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}"

# Цвет заливки врезки -> тип. Взято из «Философии» (см. CLAUDE.md §5).
# Если в новой книге появится другой цвет — его надо дописать сюда,
# иначе врезка станет обычным абзацем без полосы и подписи.
FILL_KINDS = {
    "EAF2FB": "two-words",
    "EAF6EC": "chapter-gist",
    "EEF8F0": "interesting",
    "F4EEFA": "original-term",
    "FDEDEC": "misconception",
    "FFF0E6": "debate",
    "FEF6E4": "thought-experiment",
    "F0F4F8": "formula",
    "F2F2F2": "quote",
    "E8F6F6": "how-discovered",
    "EEF1F8": "timeline",
    "F3EFE9": "philosopher-life",
}

HEADING_STYLES = {"Heading1": "part", "Heading2": "chapter", "Heading3": "heading3"}


def slugify(text, fallback):
    text = text.strip().lower()
    text = re.sub(r"[^a-zа-я0-9]+", "-", text, flags=re.I)
    text = re.sub(r"-+", "-", text).strip("-")
    return text or fallback


def run_text_html(run):
    """Текст одного <w:r> с базовым форматированием, экранированный под innerHTML."""
    texts = []
    for t in run.findall(f"{W}t"):
        texts.append(t.text or "")
    for _ in run.findall(f"{W}tab"):
        texts.append("\t")
    for _ in run.findall(f"{W}br"):
        texts.append("\n")
    text = "".join(texts)
    if not text:
        return ""
    text = (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
    rpr = run.find(f"{W}rPr")
    if rpr is not None:
        if rpr.find(f"{W}b") is not None and rpr.find(f"{W}b").get(f"{W}val") != "0":
            text = f"<b>{text}</b>"
        if rpr.find(f"{W}i") is not None:
            text = f"<i>{text}</i>"
        if rpr.find(f"{W}strike") is not None:
            text = f"<s>{text}</s>"
    return text


def paragraph_html(p):
    return "".join(run_text_html(r) for r in p.findall(f"{W}r"))


def paragraph_fill(p):
    ppr = p.find(f"{W}pPr")
    if ppr is None:
        return None
    shd = ppr.find(f"{W}shd")
    if shd is None:
        return None
    return shd.get(f"{W}fill")


def paragraph_style(p):
    ppr = p.find(f"{W}pPr")
    if ppr is None:
        return None
    style = ppr.find(f"{W}pStyle")
    return style.get(f"{W}val") if style is not None else None


def paragraph_is_list_item(p):
    ppr = p.find(f"{W}pPr")
    return ppr is not None and ppr.find(f"{W}numPr") is not None


def paragraph_image_rid(p):
    blip = p.find(f".//{A}blip")
    if blip is None:
        return None
    return blip.get(f"{R}embed")


class Book:
    def __init__(self, book_id, title, subtitle):
        self.id = book_id
        self.title = title
        self.subtitle = subtitle
        self.parts = []          # meta: [{id, title, chapters:[{id,title}]}]
        self.part_files = {}     # part_id -> {"id":..,"title":..,"chapters":[...]}
        self._cur_part = None
        self._cur_chapter = None
        self._box_count = {}
        self._table_count = 0
        self._image_count = 0

    def add_part(self, title):
        part_id = f"part-{len(self.parts) + 1}"
        self.parts.append({"id": part_id, "title": title, "chapters": []})
        self.part_files[part_id] = {"id": part_id, "title": title, "chapters": []}
        self._cur_part = part_id
        self._cur_chapter = None

    def add_chapter(self, title):
        if self._cur_part is None:
            self.add_part("Без названия")
        part_meta = self.parts[-1]
        chapter_id = f"ch-{sum(len(p['chapters']) for p in self.parts) + 1}"
        part_meta["chapters"].append({"id": chapter_id, "title": title})
        self.part_files[self._cur_part]["chapters"].append(
            {"id": chapter_id, "title": title, "blocks": []}
        )
        self._cur_chapter = chapter_id

    def add_block(self, block):
        if self._cur_chapter is None:
            self.add_chapter("Без названия")
        chapters = self.part_files[self._cur_part]["chapters"]
        chapters[-1]["blocks"].append(block)
        if block["type"] == "box":
            self._box_count[block["kind"]] = self._box_count.get(block["kind"], 0) + 1
        elif block["type"] == "table":
            self._table_count += 1
        elif block["type"] == "image":
            self._image_count += 1


def convert(docx_path, out_dir, book_id, title, subtitle):
    zf = zipfile.ZipFile(docx_path)
    doc_xml = zf.read("word/document.xml")
    rels_xml = zf.read("word/_rels/document.xml.rels")

    rels_root = ET.fromstring(rels_xml)
    rel_ns = "{http://schemas.openxmlformats.org/package/2006/relationships}"
    rid_to_target = {
        rel.get("Id"): rel.get("Target")
        for rel in rels_root.findall(f"{rel_ns}Relationship")
    }

    root = ET.fromstring(doc_xml)
    body = root.find(f"{W}body")

    book = Book(book_id, title, subtitle)

    box_buffer = []       # список параграфов текущей врезки
    box_fill = None
    list_buffer = []      # список html строк текущего маркированного списка
    seen_part = False     # титульный лист и оглавление перед первой ЧАСТЬЮ — не книга

    def flush_list():
        if list_buffer:
            book.add_block({"type": "list", "items": list(list_buffer)})
            list_buffer.clear()

    def flush_box():
        nonlocal box_fill
        if not box_buffer:
            return
        kind = FILL_KINDS.get(box_fill, box_fill or "unknown")
        # Первый абзац врезки — подпись капсом, дальше идёт содержимое.
        body_paragraphs = box_buffer[1:] if len(box_buffer) > 1 else box_buffer
        book.add_block({"type": "box", "kind": kind, "html": [h for h in body_paragraphs if h]})
        box_buffer.clear()
        box_fill = None

    for el in body:
        tag = el.tag

        if not seen_part:
            # Титульный лист и оглавление перед первой ЧАСТЬЮ (Heading1) сайту
            # не нужны — своё оглавление он строит сам из meta.json.
            if tag == f"{W}p" and paragraph_style(el) == "Heading1":
                seen_part = True
            else:
                continue

        if tag == f"{W}tbl":
            flush_list()
            flush_box()
            rows = []
            for tr in el.findall(f"{W}tr"):
                row = []
                for tc in tr.findall(f"{W}tc"):
                    cell_html = " ".join(
                        paragraph_html(p) for p in tc.findall(f"{W}p") if paragraph_html(p)
                    )
                    row.append(cell_html)
                if row:
                    rows.append(row)
            if rows:
                book.add_block({"type": "table", "rows": rows})
            continue

        if tag != f"{W}p":
            continue

        style = paragraph_style(el)

        if style in HEADING_STYLES:
            flush_list()
            flush_box()
            text = paragraph_html(el)
            text = re.sub(r"</?[bis]>", "", text)  # заголовки без inline-разметки
            kind = HEADING_STYLES[style]
            if kind == "part":
                book.add_part(text)
            elif kind == "chapter":
                book.add_chapter(text)
            else:
                book.add_block({"type": "heading3", "html": text})
            continue

        rid = paragraph_image_rid(el)
        if rid is not None:
            flush_list()
            flush_box()
            target = rid_to_target.get(rid)
            if target:
                book.add_block({"type": "image", "src": f"media/{Path(target).name}"})
            continue

        fill = paragraph_fill(el)
        html = paragraph_html(el)

        if fill:
            if box_fill is not None and fill != box_fill:
                flush_box()
            box_fill = fill
            if html:
                box_buffer.append(html)
            continue

        flush_box()

        if paragraph_is_list_item(el):
            if html:
                list_buffer.append(html)
            continue

        flush_list()
        if html:
            book.add_block({"type": "p", "html": html})

    flush_list()
    flush_box()

    # --- запись на диск ---
    book_dir = out_dir / book_id
    media_dir = book_dir / "media"
    media_dir.mkdir(parents=True, exist_ok=True)

    for name in zf.namelist():
        if name.startswith("word/media/") and not name.endswith("/"):
            data = zf.read(name)
            (media_dir / Path(name).name).write_bytes(data)

    meta = {
        "id": book.id,
        "title": book.title,
        "subtitle": book.subtitle,
        "stats": (
            f"{len(book.parts)} частей · "
            f"{sum(len(p['chapters']) for p in book.parts)} глав"
        ),
        "parts": book.parts,
    }
    (book_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    for part_id, part_data in book.part_files.items():
        (book_dir / f"{part_id}.json").write_text(
            json.dumps(part_data, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    print(f"Частей: {len(book.parts)}")
    print(f"Глав: {sum(len(p['chapters']) for p in book.parts)}")
    print(f"Таблиц: {book._table_count}")
    print(f"Изображений: {book._image_count}")
    print(f"Врезок по типам: {book._box_count}")
    print(f"Врезок всего: {sum(book._box_count.values())}")
    unknown = {k: v for k, v in book._box_count.items() if k not in FILL_KINDS.values()}
    if unknown:
        print(f"ВНИМАНИЕ: неизвестные цвета врезок, допиши в FILL_KINDS: {unknown}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("docx_path", type=Path)
    parser.add_argument("out_dir", type=Path)
    parser.add_argument("book_id")
    parser.add_argument("title")
    parser.add_argument("subtitle", nargs="?", default="")
    args = parser.parse_args()
    convert(args.docx_path, args.out_dir, args.book_id, args.title, args.subtitle)


if __name__ == "__main__":
    main()
