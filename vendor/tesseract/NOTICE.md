# Bundled local OCR assets

These files are distributed with the application so OCR can run without a CDN or image upload.

| Component | Pinned source | License |
| --- | --- | --- |
| Tesseract.js API and browser worker | [npm `tesseract.js@6.0.1`](https://www.npmjs.com/package/tesseract.js/v/6.0.1) | Apache-2.0; see `TESSERACT-JS-LICENSE.md` and bundle license notices |
| Tesseract.js Core LSTM WASM | [npm `tesseract.js-core@6.0.0`](https://www.npmjs.com/package/tesseract.js-core/v/6.0.0) | Apache-2.0; see `CORE-LICENSE.txt` |
| Simplified Chinese `chi_sim` model | [tesseract-ocr/tessdata_fast tag 4.1.0, commit `65727574dfcd264acbb0c3e07860e4e9e9b22185`](https://github.com/tesseract-ocr/tessdata_fast/tree/65727574dfcd264acbb0c3e07860e4e9e9b22185) | Apache-2.0; see `LANG-LICENSE.txt` |

`chi_sim.traineddata.gz` is a deterministic gzip of the upstream `chi_sim.traineddata` file (SHA-256 of uncompressed source: `a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730`). The application forces LSTM OEM 1, so the two LSTM core builds cover SIMD and non-SIMD browsers. The browser worker selects between those two builds. Their `.wasm.js` files embed the WASM bytes, so standalone `.wasm` binaries are not needed. All runtime URLs are relative to this application.

The OCR is a tie-breaker for close visual candidates. It does not establish image recognition accuracy or imply iPhone performance has been measured.
