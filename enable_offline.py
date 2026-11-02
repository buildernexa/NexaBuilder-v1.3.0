#!/usr/bin/env python3
"""Generate a resilient service-worker cache for a prepared static website.

Only small same-origin application files are precached. Large videos/audio are
streamed online when available and are intentionally not part of the install
transaction, so a missing/large optional media file cannot break offline setup.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else None
if root is None or not (root / "index.html").is_file():
    raise SystemExit("Offline cache setup requires a prepared web root containing index.html")

# Keep the install cache bounded; the mandatory HTML shell is always included.
max_file_bytes = 4 * 1024 * 1024
max_total_bytes = 32 * 1024 * 1024
excluded_media = {".mp4", ".webm", ".mov", ".mkv", ".mp3", ".wav", ".flac", ".aac", ".ogg"}
files: list[str] = ["./index.html"]
total = (root / "index.html").stat().st_size
for path in sorted(root.rglob("*")):
    if not path.is_file() or path.name == "sw.js" or path == root / "index.html":
        continue
    rel = path.relative_to(root).as_posix()
    if any(part.startswith(".") for part in Path(rel).parts):
        continue
    if path.suffix.lower() in excluded_media or path.stat().st_size > max_file_bytes:
        continue
    if total + path.stat().st_size > max_total_bytes:
        continue
    files.append("./" + rel)
    total += path.stat().st_size

sw = (
    "const CACHE='nexabuild-offline-v2';\n"
    + "const FILES=" + json.dumps(files, ensure_ascii=False) + ";\n"
    + "self.addEventListener('install',event=>event.waitUntil((async()=>{const cache=await caches.open(CACHE);await cache.add('./index.html');await Promise.allSettled(FILES.filter(file=>file!=='./index.html').map(file=>cache.add(file)));await self.skipWaiting();})()));\n"
    + "self.addEventListener('activate',event=>event.waitUntil((async()=>{const keys=await caches.keys();await Promise.all(keys.filter(key=>key.startsWith('nexabuild-offline-')&&key!==CACHE).map(key=>caches.delete(key)));await self.clients.claim();})()));\n"
    + "self.addEventListener('fetch',event=>{const request=event.request;if(request.method!=='GET')return;const url=new URL(request.url);if(url.origin!==self.location.origin)return;event.respondWith((async()=>{const cache=await caches.open(CACHE);if(request.mode==='navigate'){try{const response=await fetch(request);if(response.ok)event.waitUntil(cache.put('./index.html',response.clone()).catch(()=>{}));return response;}catch{return (await cache.match('./index.html'))||Response.error();}}const hit=await cache.match(request);if(hit)return hit;try{const response=await fetch(request);const length=Number(response.headers.get('content-length')||0);if(response.ok&&length>0&&length<=4194304&&!/\\.(mp4|webm|mov|mkv|mp3|wav|flac|aac|ogg)(?:$|\\?)/i.test(url.pathname))event.waitUntil(cache.put(request,response.clone()).catch(()=>{}));return response;}catch{return Response.error();}})());});\n"
)
(root / "sw.js").write_text(sw, encoding="utf-8")
index = root / "index.html"
html = index.read_text(encoding="utf-8")
registration = "<script>if('serviceWorker' in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));}</script>"
if "navigator.serviceWorker.register('./sw.js')" not in html:
    if re.search(r"</body\s*>", html, flags=re.IGNORECASE):
        html = re.sub(r"</body\s*>", lambda match: registration + match.group(0), html, count=1, flags=re.IGNORECASE)
    elif re.search(r"</html\s*>", html, flags=re.IGNORECASE):
        html = re.sub(r"</html\s*>", lambda match: registration + match.group(0), html, count=1, flags=re.IGNORECASE)
    else:
        html += registration
index.write_text(html, encoding="utf-8")
print(f"Offline cache generated for {len(files)} small local files; media/video files are excluded to avoid cache quota failures.")
