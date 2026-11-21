# 🦫 Burrow

A self-hosted bookmark manager, read-it-later app and web archive (in the spirit of Hoarder/Karakeep and Linkwarden), plus a Chrome extension for tab workspaces and stashed tab stacks (in the spirit of Workona and Stackable).

```
burrow/
├── docker-compose.yml
├── server/        Node 22 + Express + SQLite (FTS5). No native deps, no build step.
│   ├── src/       API, page fetcher/archiver, AI tagger
│   └── public/    Web app (vanilla JS SPA)
└── extension/     Chrome MV3 extension (popup, side panel, options)
```

## Features

**Server / web app**
- Save **links**, **notes** and **files** (images, PDFs, anything up to 50 MB). You can drag and drop into the composer.
- Each link is fetched in the background to get its title, description, preview image, favicon and author.
- **Reader view**: a clean article extracted with Mozilla Readability.
- **Snapshot archive**: a static HTML copy of every page, with scripts stripped. It's served in a sandbox and can be downloaded, so it stays readable after the original page disappears.
- **Full-text search** across titles, notes, URLs, tags and page content. Uses SQLite FTS5 with prefix matching.
- **Tags** that work like Obsidian's:
  - **Suggestions while typing**: in tag fields, after `#` in notes and the composer, and in the search box.
  - **Inline tags**: write `#meeting` in a note to tag it. A YAML `tags:` list at the top of a note works too.
  - **Search**: `tag:#meeting`, `tag:meeting` or just `#meeting`, combined with normal text (`tag:recipe pasta`).
  - **Nested tags**: `#inbox/to-read` shows under `#inbox` in the sidebar, and `tag:inbox` also matches its nested tags.
  - **Format**: letters, numbers, `_`, `-`, `/` and emoji; no spaces; at least one non-number (`#1984` isn't a tag, `#y1984` is). Tags are case-insensitive and keep the casing they were first created with.
  - Click any tag to see everything with it. **Rename** moves nested tags along, merges with an existing tag of the same name, and updates the `#tags` in your notes.
- **Collections**, **favorites**, **archive**, **bulk actions** (tag, move, archive, delete).
- Optional **AI auto-tagging** with Claude or a local Ollama model. AI tags show as `✦ tag`.
- **Import** Netscape bookmark HTML from Chrome, Firefox, Pocket, Raindrop, Linkwarden or Hoarder; folders become collections. Also imports Burrow JSON.
- **Export** as JSON (everything) or bookmark HTML.
- A **Tab spaces** page shows the workspaces and stacks synced from the extension.
- **Themes**: a global theme for Home and every page, and each collection can have its own. Tap **🎨 Theme** in a page header to edit with a live preview:
  - Accent color and light/dark/auto mode
  - A background image (upload or URL) or gradient, with blur and dim controls
  - A page header with emoji, subtitle and an optional gradient or image banner
  - Card layout (grid/list), size, corner radius and see-through "glass" cards
- Multi-user (opt-in), API tokens, mobile layout.

**Chrome extension**
- **Popup**: save the current page with title, tags, collection and note. It shows when a page is already saved and lets you edit it.
- **Side panel tab manager** (`Alt+Shift+T`):
  - **Tabs**: all windows, grouped by tab group, plus:
    - Close duplicates, group by site, ungroup and sort
    - Stash all tabs, or save all tabs to Burrow
    - Multi-select to stash, group, save, close or make a workspace
  - **Workspaces** (Workona-style): a named set of tabs.
    - Switching swaps the window's tabs, restoring pins and tab groups.
    - The active workspace **auto-saves** as you browse.
    - Open a workspace in a new window, rename it, or set a color or emoji.
  - **Stacks** (Stackable-style): stash a tab, tab group or whole window to free memory, then restore it later.
    - Drag a tab onto a stack, or choose "Stash into…" to add to an existing one.
    - Restore all or single tabs, keep the stack after restoring, or convert it into a workspace.
  - **Search** across open tabs, workspaces, stacks *and* your Burrow bookmarks.
- Right-click menu: save page, link or selection (as a note); stash tab or window.
- Shortcuts: `Alt+Shift+S` open popup, `Alt+Shift+B` instant save. A toolbar badge shows ✓ on pages you've already saved.
- Workspaces and stacks are **synced to your server** using last-write-wins per space, so they follow you between computers.

## Run the server

### Docker (recommended)

```bash
docker compose up -d --build
```

Open <http://localhost:3000>. The first account you create becomes the owner. Data lives in the `burrow-data` volume (`/data`: `burrow.db`, `archives/`, `uploads/`).

### On a VPS with Cosmos Cloud

GitHub Actions builds a ready-made image, `ghcr.io/raydevxyz/burrow:latest`, on every push to `main`.

1. **Make the image public** (once): on GitHub, go to your profile → **Packages** → `burrow` → **Package settings** → **Change visibility** → Public. Otherwise the server needs a GitHub login to pull it.
2. **Point your domain** (e.g. `burrow.example.com`) at the VPS with a DNS **A record**.
3. In Cosmos, open **ServApps**, choose the option to **import a compose file**, and paste [`cosmos-compose.yml`](cosmos-compose.yml).
4. In Cosmos **URLs**, create a URL for `burrow.example.com` with target **`http://burrow:3000`**. Cosmos provides the HTTPS certificate.
5. Open `https://burrow.example.com` and create your account. Put that URL in the extension's options.

To update, push to `main`, wait for the GitHub Action to finish, then update or recreate the container in Cosmos so it pulls the new `latest` image.

### Without Docker

Needs Node.js **22.13+**, which includes the built-in `node:sqlite`.

```bash
cd server
npm install
npm start
```

Data goes to `server/data/` unless you set `DATA_DIR`.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | Database, archives and uploads |
| `ALLOW_SIGNUP` | `false` | Let more people register after the first account |
| `TRUST_PROXY` | `false` | Set `true` behind an HTTPS reverse proxy (for secure cookies) |
| `BLOCK_PRIVATE_URLS` | `false` | Refuse to fetch LAN/localhost URLs. Turn this on if you allow sign-ups. |
| `AI_PROVIDER` | *(off)* | `anthropic` or `ollama` |
| `ANTHROPIC_API_KEY` | | Required for `anthropic` |
| `AI_MODEL` | `claude-opus-5-5` / `llama3.2` | Model used for tagging. `claude-haiku-5-5` is a much cheaper Claude option. |
| `OLLAMA_URL` | `http://localhost:11434` | For `ollama` |

When Claude tagging is on, Burrow enables the API's server-side refusal fallback. If a request is declined, the API retries it on a fallback model within the same call.

For HTTPS, put Burrow behind Caddy, Traefik or nginx and set `TRUST_PROXY=true`. With Caddy, for example:

```
burrow.example.com {
  reverse_proxy localhost:3000
}
```

## Install the extension

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `extension/` folder. It also works in Edge, Brave, Arc and Vivaldi.
3. The options page opens. In the Burrow web app, go to **Settings → New token**, then paste the server URL and token and click **Save & test**.
4. Pin the extension. Use the popup to save pages, and `Alt+Shift+T` (or "Tab manager" in the popup) for workspaces and stacks.

The extension talks to your server with a Bearer token over CORS, so it needs no host permissions.

## Android app (share menu)

Burrow installs as an app on Android. Once it's installed, **Burrow appears in the share menu** of Chrome, YouTube, Reddit and other apps, so you can save links and text from anywhere.

1. On your phone, open your Burrow URL in **Chrome** and sign in. The site needs HTTPS (a Cosmos URL or another reverse proxy provides it).
2. Tap **⋮ → Install app** (on some phones it's **Add to Home screen → Install**). You can also use **Settings → 📲 Install app** inside Burrow.
3. In any app, tap **Share → Burrow**. Add tags, a collection or a note if you like, then tap **Save link**.

Shared text without a link is saved as a note. If your phone is offline, shares are queued and sent the next time you open Burrow. The share menu works on Android with Chrome, Edge or Samsung Internet; iPhone doesn't let web apps appear in the share menu.

## API

Every endpoint is under `/api` and authenticates with either the session cookie or `Authorization: Bearer <token>`.

| Method | Path | |
|---|---|---|
| GET | `/bookmarks?q=&tag=&collection=&favorite=1&archived=1&type=link\|note\|file&sort=&limit=&offset=` | List and search |
| POST | `/bookmarks` `{url \| note, title?, tags?, collectionId?}` | Create (returns the existing item if the URL is already saved) |
| POST | `/bookmarks/upload` (multipart `file`) | Upload a file |
| GET/PATCH/DELETE | `/bookmarks/:id` | Read, update or delete one item |
| POST | `/bookmarks/:id/refetch` | Re-fetch and re-archive |
| GET | `/bookmarks/:id/archive`, `/bookmarks/:id/file` | Snapshot, file |
| GET | `/bookmarks/lookup?url=` | Is this URL saved? |
| POST | `/bookmarks/bulk` `{ids, action: delete\|archive\|favorite\|move\|tag, value}` | Bulk actions |
| GET/PATCH/DELETE | `/tags`, `/tags/:id` | Tags |
| GET/POST/PATCH/DELETE | `/collections`, `/collections/:id` | Collections |
| GET, POST | `/spaces`, `/spaces/sync` | Extension workspaces and stacks |
| GET, POST | `/export?format=html`, `/import` | Export, import |

Example:

```bash
curl -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://example.com","tags":["demo"]}' http://localhost:3000/api/bookmarks
```

## Security notes

- Passwords are hashed with scrypt. API tokens and sessions are stored only as SHA-256 hashes.
- Archived pages and the reader view are rendered in sandboxed frames with `CSP: sandbox`, so archived content can't run scripts or read your session.
- Uploaded files are served with `nosniff` and a sandbox CSP. Anything that isn't an image, PDF or plain text is downloaded rather than displayed.
- Cross-origin API calls only work with a Bearer token; cookies are never accepted cross-origin.
