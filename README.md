# Alpha Notes

A static PDF and lined-notes markup app that can run on GitHub Pages.

## GitHub Pages

1. Push this repository to GitHub.
2. In the repository settings, open **Pages**.
3. Set the source to your main branch and the repository root.
4. Open the published Pages URL.

GitHub Pages serves `index.html` directly. No Python or Flask server is needed for the published site.

## Storage

- Imported PDFs are saved in the browser with IndexedDB.
- Notes, lined documents, snippets, masks, and spacing edits are saved in the browser with IndexedDB.
- Data is local to the browser and device. It is not uploaded to GitHub.

## Local Preview

You can open `index.html` directly, or serve the folder with any static file server.

## Notes

PDF rendering uses PDF.js from the CDN. The local `static/pdf.worker.min.js` file points PDF.js at the matching CDN worker.

The old Flask app remains in `app.py` for local experimentation, but the GitHub Pages version uses only `index.html` and the `static/` folder.
