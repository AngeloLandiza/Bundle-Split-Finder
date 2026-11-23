> Superseded by step 13: see [the step 13 plan](superpowers/plans/2026-11-22-step-13-agent-workplace.md) and [desktop-app.md](desktop-app.md). Kept for history.

# Windows VM (UTM) — extension + local agent

Split Finder is a **Chrome extension**. The optional **local agent** is a small Node server (`npm run agent:dashboard`, port **8790**). There is no single Windows installer that replaces Chrome; these steps make setup one-time and day-to-day use a double-click.

## Before you open the VM

On your Mac (in this repo):

```bash
npm install
npm run vm:bundle
```

That writes **`output/split-finder-vm-kit.zip`**: unpacked extension, `windows/` launchers, and this guide.

Put the VM kit on the guest one of these ways:

- **Shared folder** — UTM → VM Settings → Sharing → map a folder that contains the repo (or the zip).
- **Copy in** — drag the zip into the VM after Windows is installed, or use a USB image.
- **Git** — inside the VM: `git clone` this repository (same as on the Mac).

## Windows guest: one-time install

Inside the VM:

1. Install **Google Chrome** ([google.com/chrome](https://www.google.com/chrome/) or `winget install Google.Chrome`).
2. Install **Node.js LTS** ([nodejs.org](https://nodejs.org/) or `winget install OpenJS.NodeJS.LTS`).
3. If you use the **full repo** (for the agent): open the repo folder and double-click  
   `windows\SplitFinder-Setup.vbs`  
   (or `SplitFinder-Setup.bat`). Setup runs `npm install`, `npm run package`, unpacks the extension to  
   `%LOCALAPPDATA%\SplitFinder\chrome-extension`, and adds **Desktop shortcuts**.

If you only copied **`split-finder-vm-kit.zip`**, unzip it and **Load unpacked** from the included `chrome-extension` folder. You still need the **full repo** on the VM to run the agent.

### Load the extension in Chrome

1. `chrome://extensions`
2. **Developer mode** on
3. **Load unpacked** → choose  
   `%LOCALAPPDATA%\SplitFinder\chrome-extension`  
   (after Setup) **or** the kit’s `chrome-extension` folder

Follow [`install.md`](install.md) for SerpApi and optional keys.

## Every day: extension + agent

Double-click **`SplitFinder-Start.vbs`** on the Desktop (or `windows\SplitFinder-Start.vbs` in the repo).

That:

- Opens a console window running **`npm run agent:dashboard`** (leave it open)
- Opens **`chrome://extensions`** so you can reload the extension after updates
- Prints the extension folder path if you need it

Dashboard: [http://127.0.0.1:8790](http://127.0.0.1:8790)

## Optional: real `.exe` launchers

The `.vbs` files behave like small apps (double-click, no extra install). Inside the VM only, you can build `.exe` wrappers:

```powershell
powershell -ExecutionPolicy Bypass -File windows\build-exes.ps1
```

Outputs go to `windows\bin\`. Requires the **ps2exe** PowerShell module (the script installs it). Use the `.exe` files only on Windows; they are not built on the Mac repo.

## UTM hardware (reminder)

For a normal **Windows 10/11 x64** ISO on Apple Silicon:

- Machine: **Intel ICH9 (x86_64)** — emulated, slower than native
- **4–8 GiB** RAM for the VM
- Attach your **Windows ISO**, complete Windows setup, then install Chrome and Node

You do **not** need a VM to use Split Finder on the Mac: `npm run ext:dev` and load `.output/chrome-mv3`.

## Updates

In the repo on the VM, pull or copy new code, run **Split Finder Setup** again, then in Chrome click **Reload** on the extension card. Do not remove the extension unless you have exported data (see `install.md`).