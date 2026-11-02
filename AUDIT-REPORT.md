# NexaBuild — Audit & Layout Revision

Tanggal audit: 2 November 2026

## Perbaikan ketahanan

- Batas upload ZIP disamakan di UI, API, dan GitHub Actions menjadi 40 MiB. Arsip juga diperiksa untuk jumlah file, ukuran hasil ekstraksi, rasio kompresi, path traversal, path duplikat, symbolic link, dan file khusus.
- Pemilihan ZIP memakai sequence guard agar pembacaan file lama tidak dapat menimpa pilihan file yang lebih baru.
- Kegagalan decode/canvas ikon ditangani sebelum job dibuat; tombol Build dipulihkan dan tidak meninggalkan histori setengah jadi.
- Pembuatan branch GitHub memeriksa ulang ref bila respons POST hilang/timeout. Dispatch workflow yang hasilnya ambigu dicatat sebagai `dispatch_uncertain`, bukan kegagalan palsu; branch upload dipertahankan agar runner yang sudah menerima dispatch tidak kehilangan ZIP.
- Polling Actions diberi jendela 60 menit dan pencarian GitHub Release diberi waktu tambahan untuk asset APK tersedia.
- Riwayat dan data komunitas tidak lagi menganggap JSON rusak sebagai data kosong. Update JSON memakai pembacaan ulang dan retry saat ada konflik penulisan.
- GlobalChat mengabaikan respons permintaan lama setelah room/issue berubah, mendukung pagination, menolak upload lampiran sebelum Issue disetel, dan menggunakan ekstensi sesuai MIME hasil konversi.
- Handler drawer lama yang berpotensi memicu aksi ganda dibuang; handler revisi menjadi satu-satunya pemilik aksi.
- Konfigurasi token yang berubah menyegarkan identitas/avatar GitHub.

## Perapihan tampilan

- Hirarki top navigation, module title, panel, form, terminal, download card, dialog, dan bottom navigation diseragamkan.
- Layout mobile satu kolom untuk form Build, dialog dapat discroll dalam tinggi layar, safe-area Android diperhitungkan, dan bottom navigation tetap empat kolom.
- Ukuran teks/target sentuh utama dinaikkan agar lebih mudah dibaca dan dioperasikan.
- Tema Liquid Glass tetap transparan dengan blur rendah; tema Neobrutalism memakai terminal putih.
- Input file tetap native secara fungsi namun tampilan kotaknya disembunyikan di balik kontrol upload kustom.

## Hasil verifikasi

- JavaScript regression tests: 27/27 lulus.
- Python tests: 7/7 lulus.
- `npm run check`: lulus.
- `node --check` pada aplikasi, revision script, dan test: lulus.
- Workflow YAML dapat diparse; semua blok `run:` lolos `bash -n`.
- CSS: 594 aturan tingkat atas, 0 kesalahan parse.
- HTML: 240 ID unik; tanpa CSS/JavaScript eksternal yang diperlukan untuk render; tanpa native `alert/confirm/prompt`; tanpa inline event handler.
- Semua pemanggilan `$()` cocok dengan elemen statis; tombol salin Keystore sengaja dibuat dinamis sebelum digunakan.
- Secret scan: tidak menemukan pola token GitHub atau private key.

## Batas verifikasi

Build Android nyata belum dijalankan pada repository pemilik karena membutuhkan token, izin GitHub Actions/Contents, dan (untuk release bertanda tangan) empat secrets keystore. Screenshot browser otomatis tidak berhasil diselesaikan di lingkungan audit, sehingga tampilan diverifikasi melalui struktur HTML/CSS dan tes layout statis, bukan uji visual langsung pada perangkat Android.

## Mobile Neobrutalism UI rebuild — 2 November 2026

- Previous visual stylesheet and decorative home ticker/slogans were replaced by a new white + lemon-lime + black Neobrutalism system.
- Header now consistently reads NEXA STUDIO; the capsule indicator shows the current module.
- Home was reduced to profile, motion, concise metrics, time/Quran, and one Build action.
- Build / History / Chat layouts are title-led and mobile-first; Build uses one column on phone widths.
- Horizontal overflow is explicitly clipped and the active content scroller permits vertical touch scrolling only.
- The old saved theme preference is ignored through a new theme storage key, so the fresh default is Neobrutalism.
- All previously referenced UI IDs remain present with no duplicates; existing application functions and server integration were retained.
- Updated verification: 28/28 JavaScript tests passed, 7/7 Python tests passed, `npm run check` passed, and CSS parser reported no syntax errors.
- A browser screenshot/device preview could not be completed in this environment; no claim of real-device visual approval is made. The owner should still preview on the target Android phone before publishing.
