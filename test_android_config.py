import subprocess
import shutil
import sys
import tempfile
import unittest
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

class AndroidConfigTests(unittest.TestCase):
    def test_metadata_permissions_and_wake_lock_are_applied(self):
        with tempfile.TemporaryDirectory() as tmp:
            android = Path(tmp)
            app = android / 'app'
            (app / 'src/main/res/values').mkdir(parents=True)
            (app / 'src/main/java/com/example').mkdir(parents=True)
            (app / 'build.gradle').write_text('''android {\n defaultConfig {\n  applicationId "com.old.app"\n  versionCode 1\n  versionName "1.0"\n }\n}\n''', encoding='utf-8')
            (app / 'src/main/AndroidManifest.xml').write_text('''<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application /></manifest>''', encoding='utf-8')
            (app / 'src/main/java/com/example/MainActivity.java').write_text('''package com.example;\nimport com.getcapacitor.BridgeActivity;\npublic class MainActivity extends BridgeActivity {}\n''', encoding='utf-8')
            result = subprocess.run([
                sys.executable, str(ROOT / 'scripts/configure_android.py'),
                '--android-dir', str(android), '--app-name', 'Nexa Demo',
                '--package-id', 'com.nexa.demo', '--version', '1.2.3',
                '--version-code', '9', '--internet-mode', 'online',
                '--camera', '--wake-lock', '--vibrate',
            ], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            gradle = (app / 'build.gradle').read_text(encoding='utf-8')
            self.assertIn('applicationId "com.nexa.demo"', gradle)
            self.assertIn('versionCode 9', gradle)
            manifest = ET.parse(app / 'src/main/AndroidManifest.xml').getroot()
            ns = '{http://schemas.android.com/apk/res/android}name'
            permissions = {node.get(ns) for node in manifest.findall('uses-permission')}
            self.assertTrue({'android.permission.INTERNET', 'android.permission.CAMERA', 'android.permission.WAKE_LOCK', 'android.permission.VIBRATE'} <= permissions)
            java = (app / 'src/main/java/com/example/MainActivity.java').read_text(encoding='utf-8')
            self.assertIn('FLAG_KEEP_SCREEN_ON', java)

    def test_offline_cache_generator_adds_service_worker(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'index.html').write_text('<!doctype html><title>test</title>', encoding='utf-8')
            (root / 'app.js').write_text('console.log("ok")', encoding='utf-8')
            result = subprocess.run([sys.executable, str(ROOT / 'scripts/enable_offline.py'), str(root)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((root / 'sw.js').is_file())
            html = (root / 'index.html').read_text(encoding='utf-8')
            self.assertIn("navigator.serviceWorker.register('./sw.js')", html)
            worker = (root / 'sw.js').read_text(encoding='utf-8')
            self.assertIn("CACHE='nexabuild-offline-v2'", worker)
            self.assertIn('./app.js', worker)
            self.assertNotIn('./large.mp4', worker)
            self.assertIn('catch{return Response.error();}', worker)
            node = shutil.which('node')
            if node:
                check = subprocess.run([node, '--check', str(root / 'sw.js')], capture_output=True, text=True)
                self.assertEqual(check.returncode, 0, check.stderr)

    def test_next_static_export_out_directory_is_supported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive_path = root / 'next-export.zip'
            with zipfile.ZipFile(archive_path, 'w', zipfile.ZIP_DEFLATED) as archive:
                archive.writestr('package.json', '{"scripts":{"build":"next build"}}')
                archive.writestr('next.config.js', 'module.exports = { output: "export" }')
                archive.writestr('out/index.html', '<!doctype html><title>Exported</title>')
                archive.writestr('out/_next/static/app.js', 'console.log("built")')
            out = root / 'www'
            result = subprocess.run([
                sys.executable, str(ROOT / 'scripts/prepare_site.py'),
                '--zip', str(archive_path), '--out', str(out),
            ], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((out / 'index.html').is_file())
            self.assertTrue((out / '_next/static/app.js').is_file())

    def test_angular_nested_browser_output_is_selected_over_source_shell(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive_path = root / 'angular.zip'
            with zipfile.ZipFile(archive_path, 'w', zipfile.ZIP_DEFLATED) as archive:
                archive.writestr('index.html', '<!doctype html><div id="app">SOURCE SHELL</div>')
                archive.writestr('package.json', '{"scripts":{"build":"ng build"}}')
                archive.writestr('angular.json', '{"projects":{}}')
                archive.writestr('dist/demo/browser/index.html', '<!doctype html><title>ANGULAR OUTPUT</title>')
                archive.writestr('dist/demo/browser/main.js', 'console.log("angular")')
            out = root / 'www'
            result = subprocess.run([
                sys.executable, str(ROOT / 'scripts/prepare_site.py'),
                '--zip', str(archive_path), '--out', str(out),
            ], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            page = (out / 'index.html').read_text(encoding='utf-8')
            self.assertIn('ANGULAR OUTPUT', page)
            self.assertNotIn('SOURCE SHELL', page)
            self.assertTrue((out / 'main.js').is_file())

    def test_framework_source_without_compiled_output_is_rejected_clearly(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive_path = root / 'vite-source.zip'
            with zipfile.ZipFile(archive_path, 'w', zipfile.ZIP_DEFLATED) as archive:
                archive.writestr('index.html', '<!doctype html><div id="app"></div>')
                archive.writestr('package.json', '{"scripts":{"build":"vite build"}}')
                archive.writestr('vite.config.js', 'export default {}')
            result = subprocess.run([
                sys.executable, str(ROOT / 'scripts/prepare_site.py'),
                '--zip', str(archive_path), '--out', str(root / 'www'),
            ], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('source framework', result.stderr.lower())

    def test_zip_traversal_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive_path = root / 'unsafe.zip'
            with zipfile.ZipFile(archive_path, 'w') as archive:
                archive.writestr('../escape.txt', 'nope')
            result = subprocess.run([
                sys.executable, str(ROOT / 'scripts/prepare_site.py'),
                '--zip', str(archive_path), '--out', str(root / 'www'),
            ], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('keluar', result.stderr.lower())

    def test_included_sample_project_prepares_as_static_site(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / 'www'
            result = subprocess.run([
                sys.executable, str(ROOT / 'scripts/prepare_site.py'),
                '--zip', str(ROOT / 'Sample-Web-Project.zip'), '--out', str(out),
            ], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            page = (out / 'index.html').read_text(encoding='utf-8')
            self.assertIn('NEXABUILD · SAMPLE WEB PROJECT', page)
            self.assertIn('uji interaksi', page.lower())

if __name__ == '__main__':
    unittest.main()
