# Darkroom

A photo library that lives on your external SSD and stays locked until that
exact drive is plugged in.

Runs entirely on your own machine. No account, no API keys, no network calls,
no cloud. Plug the drive in and your photos are there; pull it out and the
library goes dark — because the photos, the thumbnails and the index all live
on the drive, and the only thing left on your computer is a note saying which
drive to look for.

```
darkroom init /Volumes/Archive/Photos --label "Archive SSD"
darkroom sync ~/Pictures
darkroom serve          # → http://127.0.0.1:4600
```

## What it does

- **Locks itself to one drive.** The library is identified by a marker file at
  its root, not by a mount path, so it keeps working when macOS mounts the
  drive as `/Volumes/Archive 1` or Windows hands it a different letter. The
  library appears when the drive appears — usually within a few seconds — and
  the interface falls back to a lock screen the moment it is unplugged.
- **Folders, as real folders.** The tree in the sidebar mirrors actual
  directories on the drive. Browse the same structure in Finder or Explorer;
  nothing is hidden inside a database you can't read.
- **Cover images for folders.** Pick any photo inside a folder as its cover, or
  let it use the newest picture in there (including from nested folders).
  Photos take titles and captions of their own, and can be favourited.
- **One-way sync from your computer.** Point Darkroom at `~/Pictures` and it
  copies new photos onto the drive, sorted into `2024/2024-03-14/` folders (or
  mirroring your layout, or all into one folder — your choice). Duplicates are
  caught by content hash, so importing the same folder twice does nothing.
  **Source folders are only ever read.** Nothing in them is moved, renamed or
  deleted.
- **Verifies itself.** The index stores a SHA-256 for every file, so Darkroom
  can re-hash the whole library and tell you if a file has silently rotted or
  gone missing — which is the thing you actually want to know about an archive
  drive.
- **Survives you reorganising it.** Move a photo into a different folder in
  Finder and the next scan follows it by content hash, keeping its caption,
  its favourite, and any folder cover pointing at it.

## Install

Needs [Node.js](https://nodejs.org) 20.11 or newer.

```bash
git clone https://github.com/999david7/Darkroom.git
cd Darkroom
npm install
```

## Set up

Plug in the drive, then create the library on it:

```bash
node src/cli.js init /Volumes/Archive/Photos --label "Archive SSD"
```

On Linux that path is usually `/media/<you>/<drive>/...`, on Windows
`E:\Photos`. Pointing `init` at a folder that already holds a Darkroom library
pairs with it instead of creating a new one — that is how you use the same
drive from a second computer.

Then start it:

```bash
npm start          # → http://127.0.0.1:4600
```

You can also do the whole setup in the browser: run `npm start` first and the
page walks you through picking a folder, with shortcuts to wherever your system
mounts removable drives.

## Getting photos in

Either drop files into the folders on the drive yourself and press **Scan**, or
let Darkroom copy them in:

```bash
node src/cli.js sync ~/Pictures
node src/cli.js sync ~/Desktop/camera-dump --into "Iceland" --organize mirror
```

Add source folders in **Settings** and the **Sync** button imports from all of
them. `--organize` takes `date` (the default, `Imported/2024/2024-03-14/`),
`mirror` (keeps your folder layout) or `flat`.

Every copy is verified by re-reading it off the drive and comparing hashes, so
a bad cable or a full disk fails loudly instead of leaving you a truncated
photo you won't notice for two years.

## Commands

| Command | What it does |
| --- | --- |
| `darkroom init <folder>` | Create a library on the drive and pair with it |
| `darkroom attach <folder>` | Pair with a library that already exists |
| `darkroom serve` | Start the web interface |
| `darkroom status` | Where the drive is and what is in the library |
| `darkroom scan` | Reconcile the index with the files on the drive |
| `darkroom sync [folder]` | Copy new photos in from your sources |
| `darkroom verify` | Re-hash every file and report anything that changed |
| `darkroom prune` | Forget index entries whose files are gone |
| `darkroom forget` | Unpair this computer; nothing on the drive changes |

Run them as `node src/cli.js <command>`, or `npm link` once to get a `darkroom`
command on your `PATH`.

## Keyboard

`←` `→` move between photos, `f` favourites one, `Esc` closes the viewer.

## How the locking works, honestly

Darkroom writes a `.darkroom-library.json` file at the root of your library
containing a random id. Your computer stores that id in
`~/.darkroom/config.json`. Every few seconds Darkroom checks whether a folder
carrying that id is reachable; when it isn't, the server refuses every request
for a photo, a thumbnail, a folder name or a count with `423 Locked`, and the
interface shows a lock screen.

**This is a "not without the drive" guarantee, not an encryption guarantee.**
Anyone holding the drive can read the photos on it, because they are ordinary
files in ordinary folders — which is deliberate, so your archive outlives this
program. If you want the contents unreadable without a key, put the library on
an encrypted volume (FileVault, LUKS, BitLocker, VeraCrypt) and let Darkroom
sit on top of it. The two work together well: the encrypted volume protects the
photos, Darkroom keeps them off your internal disk and out of your library
when the drive is away.

What Darkroom *does* guarantee is that nothing about your photos is left
behind on the computer. The index, the thumbnail cache and the trash all live
in `.darkroom/` on the drive. Image responses are sent with `Cache-Control:
no-store` so the browser does not quietly build a copy of your library in its
own disk cache. The only local file is the pairing.

## Where everything lives

```
<your drive>/Photos/
├── .darkroom-library.json     the marker that identifies this library
├── .darkroom/
│   ├── index.db               SQLite: folders, captions, covers, hashes
│   ├── cache/                 rendered thumbnails (WebP)
│   └── trash/                 deleted photos, by date — never erased
├── Iceland 2024/              your folders, exactly as you made them
│   └── DSC_0413.jpg
└── Imported/2024/2024-03-14/
```

`~/.darkroom/config.json` on your computer holds the drive id, its label, where
it was last seen, and your sync sources. Delete it and you lose nothing but the
pairing — `darkroom attach` puts it back.

## Deleting things

"Move to trash" moves the file into `.darkroom/trash/<date>/` on the drive. It
is never unlinked. To actually free the space, delete that folder yourself once
you're sure. `darkroom prune` only forgets index rows for files that are
already gone; it never touches a file.

## Safety notes

- The server listens on `127.0.0.1` only. It has no login of its own, so if you
  change the host to expose it on your network, anyone who can reach that
  address can see your photos. It will warn you when you do.
- Requests are rejected unless the `Host` header is local, which closes off DNS
  rebinding from a page you have open in another tab.
- The page runs under a strict Content-Security-Policy and loads nothing
  external.

## File formats

JPEG, PNG, WebP, TIFF, GIF and AVIF display normally. Camera RAW files
(`.cr2`, `.nef`, `.arw`, `.dng`, and the rest) are **indexed and counted** but
not decoded — they show a placeholder tile unless the camera also wrote a JPEG
next to them, in which case that is used. HEIC usually will not render; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for why, and how to change it.

Video is not supported yet.

## Development

```bash
npm test        # 80 tests, no network, no fixtures to download
```

The tests create real libraries in temp directories with real JPEGs, then do
things like delete the marker file mid-run to check that the lock actually
engages.

```
src/
├── volume.js    finding the drive, and noticing when it leaves
├── db.js        schema
├── library.js   folders, photos, covers, search
├── scanner.js   reconciling the index with the disk; verify
├── sync.js      importing from your computer
├── thumbs.js    rendering and caching
├── server.js    HTTP, and the lock that gates all of it
└── cli.js
public/          the interface: three files, no build step, no framework
```

There is no bundler and no transpiler. Edit a file in `public/`, reload the
page.

## License

MIT — see [LICENSE](LICENSE). Dependency licenses and the one LGPL component
worth understanding before you redistribute are covered in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
