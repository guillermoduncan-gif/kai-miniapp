#!/usr/bin/env python3
"""
Run from inside ~/Documents/kai-miniapp:
  python3 fix_logo_final.py
"""
import os, re, shutil, subprocess, base64
from datetime import datetime

TARGET = os.path.expanduser('~/Documents/kai-miniapp/webview.html')
LOGO   = os.path.expanduser('~/Documents/kai-miniapp/ChatGPT Image May 2, 2026 at 09_30_44 PM.png')

if not os.path.exists(TARGET):
    print(f"ERROR: {TARGET} not found.")
    raise SystemExit(1)

if not os.path.exists(LOGO):
    print(f"ERROR: Logo not found at: {LOGO}")
    raise SystemExit(1)

# ── Read and encode the real PNG ──────────────────────────────────────────
with open(LOGO, 'rb') as f:
    png_bytes = f.read()

# Verify it's a real PNG
if png_bytes[:8] != bytes([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]):
    print(f"ERROR: File is not a valid PNG (header: {png_bytes[:8].hex()})")
    raise SystemExit(1)

clean_b64 = base64.b64encode(png_bytes).decode('ascii')
print(f"[1/4] Logo PNG read OK → {len(png_bytes):,} bytes → {len(clean_b64):,} base64 chars")
print(f"      PNG header: {png_bytes[:8].hex()} ✅")

# ── Backup and patch ──────────────────────────────────────────────────────
backup = TARGET + '.bak_' + datetime.now().strftime('%Y%m%d_%H%M%S')
shutil.copy2(TARGET, backup)
print(f"[2/4] Backup → {backup}")

with open(TARGET, 'r', encoding='utf-8') as f:
    html = f.read()

# Replace the LOGO_B64 value
new_html = re.sub(
    r"const LOGO_B64 = '[^']*';",
    f"const LOGO_B64 = '{clean_b64}';",
    html, count=1
)

if new_html == html:
    print("ERROR: Could not find 'const LOGO_B64 = ...' to replace.")
    raise SystemExit(1)

with open(TARGET, 'w', encoding='utf-8') as f:
    f.write(new_html)
print(f"[3/4] Wrote updated webview.html")

# ── Commit and push ───────────────────────────────────────────────────────
print("[4/4] Committing and pushing...")
os.chdir(os.path.dirname(TARGET))
subprocess.run(['git', 'add', 'webview.html'], check=True)
subprocess.run(['git', 'commit', '-m', 'fix: embed correct KAI logo PNG'], check=True)
subprocess.run(['git', 'push'], check=True)

print("\n✅ Done! Railway redeploys in ~60s. Logo should now appear correctly.")
