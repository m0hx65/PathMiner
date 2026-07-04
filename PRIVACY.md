# Privacy Policy
## Introduction
PathMiner processes endpoint data locally in your browser. It does not send collected data to third parties; optional tools make requests only to the target site when you trigger them.

## Information We Collect
- Passive network capture includes endpoint metadata (URL, method, status, content type, size, timing).
- In-page hooks capture URL + method only (no headers, cookies, or bodies).
- In-page scans extract path strings from the DOM and linked scripts; same-origin results are stored in the local workspace so they can be scored and exported.
- Secret detection scans page and script content locally. Only finding metadata is stored — the finding type, the source URL, and a masked preview (e.g. `AKIA…4Q (20 chars)`). The raw secret value is never stored or transmitted.
- Workspace key (hostname) used to organize local results.

## Data Storage
- Data is stored locally using Chrome storage (chrome.storage.local).
- URLs are redacted before storage.
- No request/response headers, cookies, or bodies are stored.

## How We Use Your Data
Data is used only to display and export endpoints inside the extension UI.

## Data Sharing
No data is shared with third parties.

## Permissions
- activeTab / scripting: run the in-page scan and inject hooks on demand.
- webRequest: observe network requests for passive capture.
- storage: save local workspace data and settings.
- host permissions: access requested URLs for analysis and user-triggered parsing.

## Optional Active Checks
OpenAPI parsing, GraphQL introspection, and the active crawler are user-triggered from the UI.
- OpenAPI parsing fetches a JSON spec from the selected URL (YAML not supported).
- GraphQL introspection sends a POST query with credentials omitted.
- The active crawler fetches same-origin pages with credentials omitted, only while running, and can be stopped at any time.

## Contact
If you have questions about this policy, contact: mohamadasaadd1@gmail.com
