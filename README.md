# SSL Code panels

Panels are small pages that sit in SSL Code's right panel next to Terminal, Browser and the rest. Anyone can make one, and SSL Code's Settings > Panels search finds it. This repository holds the list that search reads, and how it is made.

## Make a panel

1. Make a **public** GitHub repository.
2. Add a page: **one self-contained HTML file** that speaks [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (any MCP Apps SDK works, inlined into the file). It can't load other files, and it can only reach the sites it declares.
3. Add a square SVG or PNG icon.
4. Add `sslcode-panel.json` at the root, following [`sslcode-panel.schema.json`](sslcode-panel.schema.json):

   ```json
   {
     "$schema": "https://raw.githubusercontent.com/swisssoftwarelaboratory/panels/main/sslcode-panel.schema.json",
     "name": "Hello",
     "description": "One line on what it shows or does.",
     "icon": "icon.svg",
     "page": "panel.html",
     "sites": ["https://api.example.com"]
   }
   ```

5. Give the repository the topic **`sslcode-panel`**.

It shows up in the search once it is listed (see below). Anyone can add it before then by pasting the repository's link into Settings > Panels.

**Two kinds of panel.** A plain panel is only its page. A **panel with tools** also names an MCP server (`"tools": { "npx": "your-package@1.2.3" }`, pinned to an exact version, or `"tools": { "command": "node", "args": ["server.mjs"] }` with its code in the repository). That server runs on the user's machine with their rights, gives the page and the agent tools, and is the only way a panel can read files.

**Needs.** A panel that only works with other software installed names it in `needs` (a Mac app by bundle id, or a command on the PATH, with a link to get it). SSL Code shows "Needs <name>" until it is there.

**What a page gets:** the theme, the open thread, opening links and downloading files after a click, drafting a message, and telling the agent what it shows. It never gets project files, other threads, keys, or acting as the user.

Samples to copy: [panel-sample](https://github.com/swisssoftwarelaboratory/panel-sample) (page only) and [panel-sample-tools](https://github.com/swisssoftwarelaboratory/panel-sample-tools) (with tools).

## How the list is made

From time to time a maintainer asks an agent to list the panels, following [the list-panels skill](skills/list-panels/SKILL.md). It searches GitHub for the topic, takes each repository's newest release (or its newest commit when it has none), and checks every version not checked yet: the panel file must follow the schema, release files must match the source, and Claude reads the page and the tools server's source for anything that steals, talks to sites it didn't declare, impersonates another panel, or hides what it does.

A version that passes goes into [`panels.json`](panels.json), pinned to the commit that was checked. A version that fails goes into [`panels-removed.json`](panels-removed.json) with the reason in one sentence, and the last version that passed stays listed. SSL Code switches off any installed panel whose version is on the removal list, and shows why. Until a new panel is listed, anyone can still add it by pasting its link into Settings > Panels.
