# PathMiner
A minimal Chrome MV3 extension for endpoint discovery and exploration.

## Features
- Passive network capture (webRequest) with method, status, content type, size, and timing.
- On-demand in-page scan (extracts paths from the DOM and linked script sources).
- Page-level hook for fetch/XHR (activated when you click Run scan).
- Endpoint scoring + tags (popup list sorted by score).
- OpenAPI JSON parsing (user-triggered; YAML not supported).
- Optional GraphQL tools (endpoint guesses + introspection).
- Workspace-scoped storage keyed by hostname with bounded retention.
- URL redaction by default and display-side dedupe (unique URL list).

## Installation
1. Clone or download this repo.
2. Open Chrome -> Extensions -> enable Developer Mode.
3. Click "Load unpacked" and select the PathMiner folder.

## Usage
- Open the extension popup on any page.
- Click **Run scan** to inject hooks and show results.
- The popup list shows unique URLs; click a row to open it.
- Use **Parse OpenAPI** on docs endpoints to import paths.
- GraphQL tools are available from the dropdown (optional).

## Privacy & Safety
- No headers, cookies, or bodies are stored.
- URLs are redacted before storage.
- Hooking is activated only when you click Run scan.
- OpenAPI parsing and GraphQL introspection run only when you trigger them.

## Changelog (local)
- Added passive capture + on-demand page hook for fetch/XHR.
- Added OpenAPI parsing and endpoint scoring.
- Simplified popup UI and added display-side dedupe.
