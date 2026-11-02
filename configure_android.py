#!/usr/bin/env python3
"""Apply app identity/version to a fresh Capacitor Android project."""
from __future__ import annotations
import argparse
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def fail(msg: str) -> None:
    print(f"NEXABUILDER_CONFIG_ERROR: {msg}", file=sys.stderr)
    raise SystemExit(2)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--android-dir", type=Path, required=True)
    parser.add_argument("--app-name", required=True)
    parser.add_argument("--package-id", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--version-code", required=True, type=int)
    parser.add_argument("--internet-mode", choices=("online", "offline"), default="online")
    parser.add_argument("--camera", action="store_true")
    parser.add_argument("--wake-lock", action="store_true")
    parser.add_argument("--vibrate", action="store_true")
    args = parser.parse_args()
    android = args.android_dir
    gradle = android / "app" / "build.gradle"
    if not gradle.is_file():
        gradle = android / "app" / "build.gradle.kts"
    if not gradle.is_file(): fail("File konfigurasi Gradle aplikasi tidak ditemukan; versi Capacitor/template mungkin berubah.")
    content = gradle.read_text(encoding="utf-8")

    def set_property(pattern: str, replacement: str, value: str, label: str) -> str:
        updated, count = re.subn(pattern, lambda _m: replacement.format(value=value), content, count=1, flags=re.MULTILINE)
        if count != 1:
            fail(f"Tidak dapat memvalidasi properti {label} pada template Gradle. Build dibatalkan supaya APK tidak memakai identitas/versi yang salah.")
        return updated

    # Capacitor's current Android template uses Groovy. Support a Kotlin DSL assignment if it appears.
    if gradle.suffix == ".kts":
        patterns = [
            (r"^\s*applicationId\s*=\s*\"[^\"]*\"", f'            applicationId = "{args.package_id}"', "applicationId"),
            (r"^\s*versionCode\s*=\s*\d+", f"            versionCode = {args.version_code}", "versionCode"),
            (r"^\s*versionName\s*=\s*\"[^\"]*\"", f'            versionName = "{args.version}"', "versionName"),
        ]
    else:
        patterns = [
            (r"^\s*applicationId\s+\"[^\"]*\"", f'        applicationId "{args.package_id}"', "applicationId"),
            (r"^\s*versionCode\s+\d+", f"        versionCode {args.version_code}", "versionCode"),
            (r"^\s*versionName\s+\"[^\"]*\"", f'        versionName "{args.version}"', "versionName"),
        ]
    for pattern, replacement, label in patterns:
        content, count = re.subn(pattern, replacement, content, count=1, flags=re.MULTILINE)
        if count != 1:
            fail(f"Tidak dapat memperbarui {label} pada template Gradle. Build dibatalkan.")
    gradle.write_text(content, encoding="utf-8")

    strings = android / "app" / "src" / "main" / "res" / "values" / "strings.xml"
    strings.parent.mkdir(parents=True, exist_ok=True)
    if strings.exists():
        try: tree = ET.parse(strings)
        except ET.ParseError as error: fail(f"strings.xml tidak valid: {error}")
        root = tree.getroot()
    else:
        root = ET.Element("resources")
        tree = ET.ElementTree(root)
    wanted = {"app_name": args.app_name, "title_activity_main": args.app_name}
    for name, value in wanted.items():
        node = root.find(f"string[@name='{name}']")
        if node is None:
            node = ET.SubElement(root, "string", {"name": name})
        node.text = value
    ET.indent(tree, space="    ")
    tree.write(strings, encoding="utf-8", xml_declaration=True)

    # Apply selected Android permissions in the manifest.
    manifest = android / "app" / "src" / "main" / "AndroidManifest.xml"
    if not manifest.is_file():
        fail("AndroidManifest.xml tidak ditemukan; izin aplikasi tidak dapat diterapkan dengan aman.")
    android_ns = "http://schemas.android.com/apk/res/android"
    ET.register_namespace("android", android_ns)
    try:
        manifest_tree = ET.parse(manifest)
    except ET.ParseError as error:
        fail(f"AndroidManifest.xml tidak valid: {error}")
    manifest_root = manifest_tree.getroot()
    if manifest_root.tag != "manifest":
        fail("Root AndroidManifest.xml tidak sesuai.")
    permission_attr = f"{{{android_ns}}}name"
    existing = {node.get(permission_attr): node for node in manifest_root.findall("uses-permission")}
    wanted = set()
    if args.internet_mode == "online":
        wanted.update(("android.permission.INTERNET", "android.permission.ACCESS_NETWORK_STATE"))
    if args.camera:
        wanted.add("android.permission.CAMERA")
        feature = manifest_root.find("uses-feature[@android:name='android.hardware.camera.any']", {"android": android_ns})
        if feature is None:
            ET.SubElement(manifest_root, "uses-feature", {permission_attr: "android.hardware.camera.any", f"{{{android_ns}}}required": "false"})
    if args.wake_lock:
        wanted.add("android.permission.WAKE_LOCK")
    if args.vibrate:
        wanted.add("android.permission.VIBRATE")
    for name in wanted:
        if name not in existing:
            ET.SubElement(manifest_root, "uses-permission", {permission_attr: name})
    # Remove the network permissions only for explicit offline mode.
    if args.internet_mode == "offline":
        for name in ("android.permission.INTERNET", "android.permission.ACCESS_NETWORK_STATE"):
            if name in existing:
                manifest_root.remove(existing[name])
    ET.indent(manifest_tree, space="    ")
    manifest_tree.write(manifest, encoding="utf-8", xml_declaration=True)

    # Wake Lock is applied natively to the Capacitor activity.
    if args.wake_lock:
        java_files = list((android / "app" / "src" / "main" / "java").rglob("MainActivity.java"))
        if not java_files:
            fail("MainActivity.java tidak ditemukan untuk menerapkan Wake Lock.")
        main_activity = java_files[0]
        java = main_activity.read_text(encoding="utf-8")
        if "FLAG_KEEP_SCREEN_ON" not in java:
            if "import android.os.Bundle;" not in java:
                java = java.replace("import com.getcapacitor.BridgeActivity;", "import android.os.Bundle;\nimport com.getcapacitor.BridgeActivity;")
            if "import android.view.WindowManager;" not in java:
                java = java.replace("import com.getcapacitor.BridgeActivity;", "import android.view.WindowManager;\nimport com.getcapacitor.BridgeActivity;")
            class_match = re.search(r"public\s+class\s+MainActivity\s+extends\s+BridgeActivity\s*\{\s*\}", java)
            if class_match:
                replacement = "public class MainActivity extends BridgeActivity {\n    @Override\n    public void onCreate(Bundle savedInstanceState) {\n        super.onCreate(savedInstanceState);\n        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);\n    }\n}"
                java = java[:class_match.start()] + replacement + java[class_match.end():]
            else:
                fail("Template MainActivity tidak dikenali; Wake Lock tidak diterapkan agar build tidak menghasilkan konfigurasi setengah jadi.")
            main_activity.write_text(java, encoding="utf-8")
    print("NEXABUILDER_CONFIG_READY: app identity, version, permissions and optional Wake Lock verified.")


if __name__ == "__main__":
    main()
