# Vendored OCR model

`rec.onnx` is the **PP-OCRv4 text-recognition** model, used by `ocr.py` to read floor codes off
already-rendered drawing PNGs for the import wizard's automatic floor assignment.

- **Source / license:** PaddleOCR (PaddlePaddle), Apache License 2.0. The ONNX export is the same
  one distributed by [RapidOCR](https://github.com/RapidAI/RapidOCR) (`ch_PP-OCRv4_rec_infer`).
- **Why vendored:** shipping the model inside the wheel keeps recognition **fully offline** (no
  download at install or run time).
- **Charset:** embedded in the model's `character` ONNX metadata, so no separate dictionary file
  is needed. The CTC label list is `["blank"] + character + [" "]` (PaddleOCR convention).
- **Input/output:** input `x` = `[N, 3, 48, W]` (BGR, normalized to `[-1, 1]`); output
  `[N, T, 6625]` softmax over the CTC label set.

This model handles Latin letters, digits, and punctuation, which is all a floor code needs. It is
**not** OpenCV-based — `ocr.py` does all image preprocessing with `numpy`/`Pillow`, so the plugin
has no X11/system-library dependency.
