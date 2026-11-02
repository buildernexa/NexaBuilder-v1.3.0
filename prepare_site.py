#!/usr/bin/env python3
"""Validate and safely extract a website ZIP into Capacitor's www directory.

This script intentionally does not run npm scripts or execute code from the uploaded ZIP.
"""
from __future__ import annotations

import argparse
import os
import shutil
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath

MAX_ENTRIES = 10_000
MAX_UNPACKED_BYTES = 160 * 1024 * 1024
MAX_SINGLE_FILE_BYTES = 80 * 1024 * 1024
MAX_COMPRESSION_RATIO = 500
PREFERRED = [
    "index.html",
    "www/index.html",
    "dist/index.html",
    "build/index.html",
    "out/index.html",
    "public/index.html",
]
FRAMEWORK_MARKERS = {
    "vite.config.js", "vite.config.ts", "vite.config.mjs", "vite.config.mts",
    "next.config.js", "next.config.mjs", "next.config.ts", "angular.json",
    "nuxt.config.js", "nuxt.config.ts", "vue.config.js", "svelte.config.js",
    "webpack.config.js", "webpack.config.ts",
}


def fail(message: str) -> None:
    print(f"NEXABUILDER_VALIDATION_ERROR: {message}", file=sys.stderr)
    raise SystemExit(2)


def safe_parts(name: str) -> tuple[str, ...]:
    # ZIPs can contain Windows separators even when built on Unix.
    normal = name.replace("\\", "/")
    if not normal or "\x00" in normal or normal.startswith("/"):
        fail(f"Nama file ZIP tidak aman: {name[:120]!r}")
    if len(normal) >= 2 and normal[1] == ":":
        fail(f"ZIP berisi path absolut: {name[:120]!r}")
    path = PurePosixPath(normal)
    if any(part in ("..", "") for part in path.parts):
        fail(f"ZIP mencoba keluar dari direktori project: {name[:120]!r}")
    if any(part == ".git" for part in path.parts):
        fail("ZIP menyertakan folder .git. Hapus metadata Git lalu kompres ulang folder website.")
    return tuple(part for part in path.parts if part not in (".", ""))


def extract_safely(archive: zipfile.ZipFile, destination: Path) -> list[str]:
    infos = archive.infolist()
    if not infos:
        fail("ZIP kosong.")
    if len(infos) > MAX_ENTRIES:
        fail(f"ZIP memiliki terlalu banyak item (maksimum {MAX_ENTRIES}).")
    total_size = sum(max(0, info.file_size) for info in infos)
    if total_size > MAX_UNPACKED_BYTES:
        fail("Ukuran total setelah diekstrak melebihi 160 MB. Kurangi aset yang tidak diperlukan.")

    root = destination.resolve()
    files: list[str] = []
    seen: set[str] = set()
    for info in infos:
        parts = safe_parts(info.filename.rstrip("/")) if info.filename.rstrip("/") else ()
        if not parts:
            continue
        key = "/".join(parts).casefold()
        if key in seen:
            fail(f"ZIP memiliki nama file duplikat: {info.filename[:120]!r}")
        seen.add(key)
        if info.file_size < 0 or info.file_size > MAX_SINGLE_FILE_BYTES:
            fail(f"Satu file terlalu besar: {info.filename[:120]!r}")
        if info.file_size > 1_000_000 and info.compress_size > 0:
            ratio = info.file_size / info.compress_size
            if ratio > MAX_COMPRESSION_RATIO:
                fail(f"Rasio kompresi tidak wajar pada {info.filename[:120]!r}; ZIP ditolak untuk mencegah ZIP bomb.")
        mode = (info.external_attr >> 16) & 0xFFFF
        kind = stat.S_IFMT(mode)
        if kind == stat.S_IFLNK:
            fail(f"ZIP berisi symbolic link yang tidak didukung: {info.filename[:120]!r}")
        if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
            fail(f"ZIP berisi jenis file khusus yang tidak didukung: {info.filename[:120]!r}")

        target = root.joinpath(*parts)
        try:
            target.resolve().relative_to(root)
        except ValueError:
            fail(f"Path ZIP keluar dari direktori tujuan: {info.filename[:120]!r}")
        if info.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            with archive.open(info, "r") as source, target.open("wb") as out:
                shutil.copyfileobj(source, out, length=1024 * 1024)
        except (RuntimeError, zipfile.BadZipFile, OSError) as error:
            fail(f"Gagal mengekstrak {info.filename[:100]!r}: {error}")
        files.append("/".join(parts))
    return files


def strip_single_wrapper(paths: list[str], root: Path) -> tuple[list[str], Path]:
    if not paths:
        return paths, root
    top_segments = {PurePosixPath(p).parts[0] for p in paths if PurePosixPath(p).parts}
    has_root_file = any(len(PurePosixPath(p).parts) == 1 for p in paths)
    if len(top_segments) == 1 and not has_root_file:
        wrapper = root / next(iter(top_segments))
        if wrapper.is_dir():
            prefix = wrapper.name + "/"
            return [p[len(prefix):] for p in paths if p.startswith(prefix)], wrapper
    return paths, root


def choose_site_root(paths: list[str], root: Path) -> Path:
    folded = {p.casefold(): p for p in paths}
    markers = {PurePosixPath(p).name.casefold() for p in paths}
    has_package = "package.json" in markers
    is_source_framework = any(marker.casefold() in markers for marker in FRAMEWORK_MARKERS)

    output_folders = ("dist", "build", "www", "out")
    preferred = list(PREFERRED)
    if has_package and is_source_framework:
        # Never choose a source-shell index.html over a compiled framework output.
        preferred = ["dist/index.html", "build/index.html", "www/index.html", "out/index.html"]
    chosen = None
    for candidate in preferred:
        if candidate.casefold() in folded:
            chosen = PurePosixPath(folded[candidate.casefold()])
            break

    if chosen is None and has_package and is_source_framework:
        nested_outputs = []
        for path in paths:
            candidate = PurePosixPath(path)
            if candidate.name.casefold() != "index.html":
                continue
            parts = [part.casefold() for part in candidate.parts[:-1]]
            folder_index = next((i for i, part in enumerate(parts) if part in output_folders), None)
            if folder_index is not None:
                nested_outputs.append((output_folders.index(parts[folder_index]), len(parts) - folder_index - 1, len(parts), str(candidate).casefold(), candidate))
        if nested_outputs:
            chosen = sorted(nested_outputs, key=lambda item: item[:-1])[0][-1]

    if chosen is None and not (has_package and is_source_framework):
        candidates = [PurePosixPath(p) for p in paths if PurePosixPath(p).name.casefold() == "index.html"]
        if candidates:
            chosen = sorted(candidates, key=lambda p: (len(p.parts), str(p).casefold()))[0]
    if chosen is None:
        fail("Tidak ditemukan index.html hasil website. ZIP source framework seperti Vite/React/Angular harus menyertakan hasil build pada folder dist/, build/, www/, atau out/; unggah hasil build, bukan source mentah.")

    if has_package and is_source_framework and not any(part.casefold() in output_folders for part in chosen.parts[:-1]):
        fail("ZIP tampaknya berisi source framework, bukan hasil build. Unggah folder hasil build dist/, build/, www/, atau out/ tanpa menjalankan package manager di server NexaBuild.")
    site_root = root.joinpath(*chosen.parts[:-1]) if len(chosen.parts) > 1 else root
    if not site_root.is_dir() or not (site_root / chosen.name).is_file():
        fail("Folder website hasil pemeriksaan tidak valid atau index.html tidak ditemukan.")
    return site_root


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zip", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    archive_path = args.zip.resolve()
    out = args.out.resolve()
    if not archive_path.is_file():
        fail("File project ZIP tidak ditemukan setelah upload.")
    if archive_path.stat().st_size <= 0 or archive_path.stat().st_size > 40 * 1024 * 1024:
        fail("Ukuran ZIP tidak valid atau melebihi batas 40 MB.")

    work_root = out.parent / "_extracted_site"
    if work_root.exists(): shutil.rmtree(work_root)
    if out.exists(): shutil.rmtree(out)
    work_root.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(archive_path, "r") as zf:
            paths = extract_safely(zf, work_root)
    except zipfile.BadZipFile:
        fail("Berkas bukan ZIP yang valid atau arsip rusak. Kompres ulang project lalu coba lagi.")
    except OSError as error:
        fail(f"ZIP tidak dapat dibaca: {error}")

    relative_paths, adjusted_root = strip_single_wrapper(paths, work_root)
    site_root = choose_site_root(relative_paths, adjusted_root)
    try:
        shutil.copytree(site_root, out, dirs_exist_ok=True, ignore=shutil.ignore_patterns(".DS_Store", "Thumbs.db", "__MACOSX"))
    except OSError as error:
        fail(f"Gagal menyiapkan file website: {error}")
    index = out / "index.html"
    if not index.is_file() or index.stat().st_size < 10:
        fail("index.html hasil persiapan kosong atau tidak valid.")
    print(f"NEXABUILDER_SITE_READY: {len(list(out.rglob('*')))} item; entry={index}")


if __name__ == "__main__":
    main()
