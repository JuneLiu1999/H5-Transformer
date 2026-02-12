#!/usr/bin/env python3
import argparse
import html
import json
import os
import traceback
from pathlib import Path

import fitz
import pytesseract
from PIL import Image
from pytesseract import Output


def bbox_to_dict(x0, y0, x1, y1):
    return {
        "x": float(x0),
        "y": float(y0),
        "w": float(max(0.0, x1 - x0)),
        "h": float(max(0.0, y1 - y0)),
    }


def write_template_html(outdir: Path, title: str):
    safe_title = html.escape(title)
    content = f"""<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{safe_title} - H5 Preview</title>
    <style>
      body {{
        margin: 0;
        font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: #1f2937;
        background: #eef2f7;
      }}
      .app {{
        max-width: 1200px;
        margin: 0 auto;
        padding: 16px;
      }}
      .toolbar {{
        position: sticky;
        top: 0;
        z-index: 20;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
        background: white;
        border: 1px solid #d1d5db;
        border-radius: 10px;
        padding: 10px;
        margin-bottom: 12px;
      }}
      .toolbar input[type="search"] {{
        min-width: 280px;
        padding: 8px;
        border: 1px solid #d1d5db;
        border-radius: 8px;
      }}
      .page {{
        background: white;
        border: 1px solid #d1d5db;
        border-radius: 10px;
        padding: 12px;
        margin-bottom: 16px;
      }}
      .page h2 {{
        margin: 0 0 10px;
        font-size: 16px;
      }}
      .canvas-wrap {{
        position: relative;
        width: fit-content;
        max-width: 100%;
        overflow: auto;
        border: 1px solid #e5e7eb;
        background: #fff;
      }}
      .canvas-wrap img.page-img {{
        display: block;
      }}
      .overlay {{
        position: absolute;
        inset: 0;
        pointer-events: none;
      }}
      .text-box,
      .ocr-box,
      .img-box {{
        position: absolute;
        border: 1px solid transparent;
      }}
      .show-text .text-box {{
        border-color: rgba(59, 130, 246, 0.35);
      }}
      .show-ocr .ocr-box {{
        border-color: rgba(34, 197, 94, 0.45);
      }}
      .show-image .img-box {{
        border-color: rgba(239, 68, 68, 0.5);
      }}
      .match {{
        background: rgba(250, 204, 21, 0.45);
      }}
      .meta {{
        margin-top: 8px;
        color: #4b5563;
        font-size: 12px;
      }}
    </style>
  </head>
  <body>
    <main class="app">
      <div class="toolbar">
        <strong>{safe_title}</strong>
        <label><input type="checkbox" id="toggleText" checked /> Text Overlay</label>
        <label><input type="checkbox" id="toggleOcr" checked /> OCR Overlay</label>
        <label><input type="checkbox" id="toggleImage" checked /> Image Overlay</label>
        <input id="search" type="search" placeholder="Search words (text layer)..." />
      </div>
      <div id="pages"></div>
    </main>
    <script>
      const pagesNode = document.getElementById('pages');
      const toggleText = document.getElementById('toggleText');
      const toggleOcr = document.getElementById('toggleOcr');
      const toggleImage = document.getElementById('toggleImage');
      const searchNode = document.getElementById('search');

      function syncToggles() {{
        document.body.classList.toggle('show-text', toggleText.checked);
        document.body.classList.toggle('show-ocr', toggleOcr.checked);
        document.body.classList.toggle('show-image', toggleImage.checked);
      }}

      function applySearch() {{
        const q = searchNode.value.trim().toLowerCase();
        document.querySelectorAll('.text-box').forEach((el) => {{
          if (!q) {{
            el.classList.remove('match');
            return;
          }}
          const text = (el.dataset.text || '').toLowerCase();
          el.classList.toggle('match', text.includes(q));
        }});
      }}

      function addBoxes(layer, cls, items) {{
        items.forEach((item) => {{
          const node = document.createElement('div');
          node.className = cls;
          node.style.left = item.x + 'px';
          node.style.top = item.y + 'px';
          node.style.width = item.w + 'px';
          node.style.height = item.h + 'px';
          if (item.text) node.dataset.text = item.text;
          if (item.text) node.title = item.text;
          layer.appendChild(node);
        }});
      }}

      async function render() {{
        const resp = await fetch('./manifest.json');
        const data = await resp.json();
        for (const p of data.pages) {{
          const section = document.createElement('section');
          section.className = 'page';
          section.innerHTML = `
            <h2>Page ${{p.pageNumber}}</h2>
            <div class="canvas-wrap" style="width:${{p.renderWidth}}px;height:${{p.renderHeight}}px;">
              <img class="page-img" src="./${{p.imagePath}}" width="${{p.renderWidth}}" height="${{p.renderHeight}}" />
              <div class="overlay"></div>
            </div>
            <div class="meta">
              spans: ${{p.items.length}} | OCR boxes: ${{p.ocrBoxes.length}} | image blocks: ${{p.imageBoxes.length}}
            </div>
          `;
          const overlay = section.querySelector('.overlay');
          addBoxes(overlay, 'text-box', p.items);
          addBoxes(overlay, 'ocr-box', p.ocrBoxes);
          addBoxes(overlay, 'img-box', p.imageBoxes);
          pagesNode.appendChild(section);
        }}
        syncToggles();
        applySearch();
      }}

      toggleText.addEventListener('change', syncToggles);
      toggleOcr.addEventListener('change', syncToggles);
      toggleImage.addEventListener('change', syncToggles);
      searchNode.addEventListener('input', applySearch);
      render();
    </script>
  </body>
</html>
"""
    (outdir / "index.html").write_text(content, encoding="utf-8")


def run_pipeline(input_pdf: Path, outdir: Path, original_name: str, tesseract_path: str):
    outdir.mkdir(parents=True, exist_ok=True)
    assets_dir = outdir / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)

    if tesseract_path:
        pytesseract.pytesseract.tesseract_cmd = tesseract_path

    doc = fitz.open(str(input_pdf))
    pages = []
    text_layers = []
    zoom = 2.0
    matrix = fitz.Matrix(zoom, zoom)

    for i, page in enumerate(doc):
        page_no = i + 1
        pix = page.get_pixmap(matrix=matrix, alpha=False)
        image_name = f"assets/page_{page_no:03d}.png"
        image_abs = outdir / image_name
        pix.save(str(image_abs))

        page_w = float(page.rect.width)
        page_h = float(page.rect.height)
        sx = float(pix.width) / page_w if page_w else 1.0
        sy = float(pix.height) / page_h if page_h else 1.0

        # Text extraction uses PyMuPDF span layer (content source of truth).
        span_items_pdf = []
        span_items_render = []
        for block in page.get_text("dict").get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    text = (span.get("text") or "").strip()
                    if not text:
                        continue
                    bbox = span.get("bbox") or [0, 0, 0, 0]
                    if len(bbox) != 4:
                        continue
                    x0, y0, x1, y1 = bbox
                    span_items_pdf.append(
                        {
                            "text": text,
                            "bbox": [float(x0), float(y0), float(x1), float(y1)],
                            "size": float(span.get("size") or 0.0),
                            "font": str(span.get("font") or ""),
                        }
                    )
                    item = bbox_to_dict(x0 * sx, y0 * sy, x1 * sx, y1 * sy)
                    item["text"] = text
                    item["size"] = float(span.get("size") or 0.0)
                    item["font"] = str(span.get("font") or "")
                    span_items_render.append(item)

        image_boxes = []
        text_dict = page.get_text("dict")
        for block in text_dict.get("blocks", []):
            if block.get("type") != 1:
                continue
            bbox = block.get("bbox")
            if not bbox or len(bbox) != 4:
                continue
            x0, y0, x1, y1 = bbox
            image_boxes.append(bbox_to_dict(x0 * sx, y0 * sy, x1 * sx, y1 * sy))

        # OCR is used only to locate potential text boxes, not content extraction.
        ocr_boxes = []
        ocr_img = Image.open(image_abs)
        ocr = pytesseract.image_to_data(
            ocr_img, lang="chi_sim+eng", output_type=Output.DICT
        )
        for j in range(len(ocr["text"])):
            conf_raw = str(ocr["conf"][j]).strip()
            try:
                conf = float(conf_raw)
            except Exception:
                conf = -1
            if conf < 0:
                continue
            l = float(ocr["left"][j])
            t = float(ocr["top"][j])
            w = float(ocr["width"][j])
            h = float(ocr["height"][j])
            if w <= 1 or h <= 1:
                continue
            box = {"x": l, "y": t, "w": w, "h": h, "conf": conf}
            ocr_boxes.append(box)

        pages.append(
            {
                "pageNumber": page_no,
                "renderWidth": int(pix.width),
                "renderHeight": int(pix.height),
                "imagePath": image_name.replace("\\\\", "/"),
                "items": span_items_render,
                "ocrBoxes": ocr_boxes,
                "imageBoxes": image_boxes,
            }
        )
        text_layers.append({"page": page_no, "items": span_items_pdf})

    doc.close()

    manifest = {"sourceFile": original_name, "pageCount": len(pages), "pages": pages}
    (outdir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
    )
    (outdir / "text-layer.json").write_text(
        json.dumps(text_layers, ensure_ascii=False), encoding="utf-8"
    )
    write_template_html(outdir, original_name)
    return {"ok": True, "pages": len(pages), "preview": "index.html"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--outdir", required=True)
    parser.add_argument("--original-name", required=True)
    parser.add_argument("--tesseract", default="")
    args = parser.parse_args()

    try:
        result = run_pipeline(
            input_pdf=Path(args.input),
            outdir=Path(args.outdir),
            original_name=args.original_name,
            tesseract_path=args.tesseract,
        )
        print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(
            json.dumps(
                {"ok": False, "error": str(exc), "traceback": traceback.format_exc()},
                ensure_ascii=False,
            )
        )
        raise


if __name__ == "__main__":
    main()
