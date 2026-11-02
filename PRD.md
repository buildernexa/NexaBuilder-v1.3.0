# NEXA STUDIO — Product Requirements

**Dashboard UI:** Mobile Neobrutalism Soft (recreated from a clean visual system)  
**Build engine:** Existing GitHub Actions integration retained  
**Status:** Frontend tests pass; real APK build still requires the owner's GitHub repository and secrets.

## Objective
Provide a phone-first dashboard for selecting a project ZIP, previewing it, setting Android identity and permissions, and starting an actual APK build through the existing workflow. The interface should feel like a native mobile workspace rather than a desktop webpage squeezed onto a phone.

## Visual system
- White / warm-white surfaces, lemon-lime accent, black ink outlines, and short hard shadows.
- Neobrutalism is the default theme. The optional Liquid Glass setting remains available, but uses low blur and restrained transparency.
- No dotted backgrounds, ornamental gradients, repeated decorative badges, oversized slogans, or unnecessary helper paragraphs.
- Header is a floating capsule: hamburger, **NEXA STUDIO**, current-page pill, and web icon.
- Bottom navigation is a single capsule with four compact modules: Home, Build, History, Chat.
- Layout is mobile-first. No horizontal page scroll; content scrolls vertically only inside the active module. Build forms collapse to one column on phone screens.
- Safe-area padding, reduced-motion behavior, touch targets, and text selection rules are included. Inputs, chat text, and logs remain selectable.

## Home
- Compact GitHub profile / role / connection status.
- One motion-video panel with mute control.
- Compact member, active-presence, and date metrics.
- Local device clock and Al-Qur'an verse card. The verse card opens a full-screen reader.
- One primary action to open Build.

## Build
- Select a ZIP from the device or import a public GitHub repository.
- Inspect ZIP entries client-side, detect likely HTML/Web, Native Android/Gradle, or Flutter projects, and reject unsafe archives.
- Full-screen preview for supported static web projects. Native/Flutter projects are not falsely shown as installed apps.
- APK build stays disabled until a project is selected and preview is completed.
- App name, Application ID, version, version code, and optional launcher icon fields.
- Online/offline mode, camera, wake lock, and haptic permission controls.
- Build motion video pool remains configurable in Settings.

## Build Lab
- Calls the real API routes: `/api/health`, `/api/upload`, `/api/status/{jobId}`, `/api/logs/{jobId}/stream`, and `/api/download/{jobId}`.
- Progress and status are based on real engine responses only. There is no fabricated successful build or APK link.
- APK download is exposed only when the server reports terminal success and a valid release asset.

## History
- Shows confirmed build history and locally stored metadata.
- Saved project ZIPs use IndexedDB when available so an entry can reopen its metadata form and rebuild from its saved source.

## Global Chat
- GitHub Issue comments are used as the shared room.
- Username/avatar come from GitHub identity.
- Text, photo, file, and saved sticker features remain connected to the existing implementation.

## Settings and account
- Local long-press fingerprint-style gate (not device biometric authentication).
- GitHub token, owner, and repository fields are separate. Token stays in local browser storage.
- Profile, theme, motion-video slots, custom font, keystore preparation, chat Issue configuration, and disconnect controls.
- Intro appears on first connection. A previously authorized device can re-enter without repeating the intro.

## Existing integration and truthful limits
- Existing API routes, GitHub Actions workflow, ZIP preparation scripts, community data, build history, and asset structure are retained.
- The public build API does not guarantee launcher icon, version metadata, and release signing for every source project. These limitations remain explicit.
- Signed releases require the corresponding GitHub Actions keystore secrets.
- A real build and Android installation must still be verified in the owner's GitHub repository and target device.
