# Third-party notices

Darkroom itself is MIT licensed (see `LICENSE`). This file records what it
depends on and what that means if you publish, fork, or redistribute it.

## Direct dependencies

| Package | License | Why it is here |
| --- | --- | --- |
| [express](https://github.com/expressjs/express) | MIT | The local HTTP server |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | MIT | The index database (SQLite itself is public domain) |
| [sharp](https://github.com/lovell/sharp) | Apache-2.0 | Reading image headers and rendering thumbnails |
| [exifr](https://github.com/MikeKovarik/exifr) | MIT | Reading capture dates and camera names from EXIF |

Everything pulled in transitively is MIT, ISC, Apache-2.0 or BSD, with one
exception, described next.

## libvips (LGPL) — the one thing worth understanding

`sharp` does not do image processing itself. It calls **libvips**, which npm
installs as a separate prebuilt package (`@img/sharp-libvips-<platform>`) and
which is licensed **LGPL-3.0-or-later**.

This is fine for an MIT project, and here is precisely why:

- libvips is a **shared library** (`libvips-cpp.so.42` / `.dylib` / `.dll`) that
  sharp loads at runtime. The LGPL's conditions on derived works are not
  triggered by dynamic linking of this kind.
- It arrives as its **own npm package with its own license file**. Darkroom's
  repository contains no libvips code, and this repository is not a combined
  work.
- Your code stays MIT. Anyone receiving Darkroom can replace the libvips build
  with their own, which is the freedom the LGPL exists to protect.

**When you would need to do something about it:** if you ever ship Darkroom as
a *single self-contained binary or installer* that bundles libvips (via `pkg`,
Electron, a Docker image you distribute, an App Store build), you should include
libvips' LGPL notice in your distribution and keep users able to substitute
their own build of it. Publishing the source on GitHub, or publishing to npm
where libvips installs itself as a dependency, requires nothing extra.

If you would rather avoid the question entirely, sharp can be swapped for a
different renderer — `src/thumbs.js` and the header read in `src/media.js` are
the only two places that touch it.

## Patents and codecs

Darkroom bundles no codecs of its own.

- Thumbnails are written as **WebP**, which is royalty-free and BSD-licensed.
- The prebuilt libvips that sharp installs **does not include HEVC**, so no
  patent-encumbered encoder is distributed. HEIC photos from an iPhone will
  therefore usually fail to decode; Darkroom handles that by indexing the file
  and drawing a placeholder tile rather than hiding it. If you build libvips
  yourself with HEIC support, they start rendering with no code change.
- Camera RAW files are indexed but never decoded. Where a camera wrote a JPEG
  next to the RAW, that sibling is used for the thumbnail.

## What Darkroom does not do

Relevant if you are weighing up publishing this:

- **No API keys, accounts, or third-party services.** There is nothing to
  configure and no secret to leak in a commit.
- **No network requests, at all.** The server talks to your browser over
  loopback; the page loads no fonts, scripts, styles or images from anywhere
  but itself. You can verify this with the browser's network tab, or by
  unplugging your internet.
- **No telemetry, analytics, or crash reporting.**
- **No GPS.** Location is the most sensitive field in a photo's metadata, and
  Darkroom never parses it or stores it. (Your original files keep whatever
  they came with — Darkroom does not modify originals.)
- **No bundled media.** Every icon in the interface is an SVG path in
  `public/index.html`, written for this project.
