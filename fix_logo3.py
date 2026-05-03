#!/usr/bin/env python3
"""
Run from inside ~/Documents/kai-miniapp:
  python3 fix_logo3.py
"""
import os, re, shutil, subprocess, base64
from datetime import datetime

TARGET = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'webview.html')

if not os.path.exists(TARGET):
    print(f"ERROR: {TARGET} not found.")
    raise SystemExit(1)

backup = TARGET + '.bak_' + datetime.now().strftime('%Y%m%d_%H%M%S')
shutil.copy2(TARGET, backup)
print(f"[1/5] Backup → {backup}")

with open(TARGET, 'r', encoding='utf-8') as f:
    html = f.read()

# ── Extract the raw base64 string ─────────────────────────────────────────
match = re.search(r"const LOGO_B64 = ['\`]([^'\`]+)['\`];", html, re.DOTALL)
if not match:
    print("ERROR: Could not find LOGO_B64.")
    raise SystemExit(1)

raw_b64 = match.group(1)
print(f"[2/5] Extracted LOGO_B64 ({len(raw_b64)} chars)")

# ── Clean: strip ALL non-base64 characters ────────────────────────────────
clean_b64 = re.sub(r'[^A-Za-z0-9+/]', '', raw_b64)
print(f"      After stripping non-base64 chars: {len(clean_b64)} chars")

# Add correct padding — base64 strings must be divisible by 4
remainder = len(clean_b64) % 4
if remainder == 1:
    # 1 extra char is always invalid base64 — drop it
    clean_b64 = clean_b64[:-1]
    remainder = len(clean_b64) % 4

if remainder != 0:
    clean_b64 += '=' * (4 - remainder)

print(f"      After padding: {len(clean_b64)} chars (mod4={len(clean_b64)%4})")

# ── Decode and re-encode to guarantee clean output ────────────────────────
try:
    png_bytes = base64.b64decode(clean_b64)
    print(f"[3/5] Decoded OK → {len(png_bytes)} bytes")
    # Verify it's actually a PNG
    if png_bytes[:4] == b'\x89PNG':
        print("      Confirmed: valid PNG ✅")
    else:
        print(f"      WARNING: not a PNG header: {png_bytes[:8].hex()}")
except Exception as e:
    print(f"ERROR decoding: {e}")
    raise SystemExit(1)

clean_b64 = base64.b64encode(png_bytes).decode('ascii')
print(f"      Re-encoded: {len(clean_b64)} chars")

# ── Replace just the LOGO_B64 value in the file ───────────────────────────
# Find and replace only the value, keeping the const declaration intact
old_match = re.search(r"(const LOGO_B64 = ['\`])[^'\`]+(['\`];)", html, re.DOTALL)
if not old_match:
    print("ERROR: Cannot find LOGO_B64 const to replace.")
    raise SystemExit(1)

new_html = html[:old_match.start()] + f"const LOGO_B64 = '{clean_b64}';" + html[old_match.end():]

# ── Also fix the forEach to use simple data URI ────────────────────────────
# Remove the (function(){ atob block if it exists, replace with simple version
new_html = re.sub(
    r"\(function\(\) \{.*?URL\.createObjectURL\(blob\);.*?\['logoImg','emptyLogo','callLogo'\]\.forEach\(id => \{.*?img\.src = url;.*?\}\);.*?\}\)\(\);",
    """['logoImg','emptyLogo','callLogo'].forEach(function(id) {
  var img = document.getElementById(id);
  if (img) img.src = 'data:image/png;base64,' + LOGO_B64;
});""",
    new_html,
    flags=re.DOTALL
)

with open(TARGET, 'w', encoding='utf-8') as f:
    f.write(new_html)
print(f"[4/5] Wrote fixed webview.html")

print("[5/5] Committing and pushing...")
os.chdir(os.path.dirname(TARGET))
subprocess.run(['git', 'add', 'webview.html'], check=True)
subprocess.run(['git', 'commit', '-m', 'fix: re-encode LOGO_B64 as clean base64'], check=True)
subprocess.run(['git', 'push'], check=True)

print("\n✅ Done! Railway redeploys in ~60s.")
