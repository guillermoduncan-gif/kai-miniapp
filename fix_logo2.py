#!/usr/bin/env python3
"""
Run from inside ~/Documents/kai-miniapp:
  python3 fix_logo2.py

This script:
1. Extracts the raw LOGO_B64 value from webview.html
2. Cleans it (strips whitespace, fixes padding)
3. Re-encodes the actual PNG bytes as clean base64
4. Replaces the broken logo code with a simple working version
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
match = re.search(r"const LOGO_B64 = ['\`]([A-Za-z0-9+/=\s]+)['\`];", html, re.DOTALL)
if not match:
    print("ERROR: Could not find LOGO_B64 in the file.")
    raise SystemExit(1)

raw_b64 = match.group(1)
print(f"[2/5] Extracted LOGO_B64 ({len(raw_b64)} chars)")

# ── Clean the base64 string ───────────────────────────────────────────────
# Remove ALL whitespace (newlines, spaces, tabs)
clean_b64 = re.sub(r'\s+', '', raw_b64)

# Fix padding
missing_padding = len(clean_b64) % 4
if missing_padding:
    clean_b64 += '=' * (4 - missing_padding)

# Validate it decodes correctly
try:
    png_bytes = base64.b64decode(clean_b64)
    print(f"[3/5] Base64 decoded OK → {len(png_bytes)} bytes")
except Exception as e:
    print(f"ERROR: Base64 still invalid after cleaning: {e}")
    print(f"  First 100 chars: {repr(clean_b64[:100])}")
    raise SystemExit(1)

# Re-encode to guarantee clean base64 with no issues
clean_b64 = base64.b64encode(png_bytes).decode('ascii')
print(f"[3/5] Re-encoded to clean base64 ({len(clean_b64)} chars)")

# ── Replace the entire LOGO_B64 declaration and usage block ───────────────
# New approach: embed as clean base64, set src directly (no atob needed)
NEW_LOGO_BLOCK = f"""const LOGO_B64 = '{clean_b64}';
(function() {{
  const dataURI = 'data:image/png;base64,' + LOGO_B64;
  ['logoImg','emptyLogo','callLogo'].forEach(function(id) {{
    var img = document.getElementById(id);
    if (img) img.src = dataURI;
  }});
}})();"""

# Remove the old LOGO_B64 const + old forEach block (handles all variants)
# Pattern matches from "const LOGO_B64" through the forEach closing
old_pattern = re.compile(
    r"const LOGO_B64 = ['\`][A-Za-z0-9+/=\s]+['\`];.*?"
    r"(?:\}\)\(\);|\['logoImg','emptyLogo','callLogo'\]\.forEach\([^;]+;\s*\}\);)",
    re.DOTALL
)

new_html, count = old_pattern.subn(NEW_LOGO_BLOCK, html, count=1)

if count == 0:
    print("ERROR: Could not find the old LOGO block to replace.")
    # Try a simpler approach — just replace the const line and the forEach
    # Replace const LOGO_B64 line
    new_html = re.sub(
        r"const LOGO_B64 = ['\`][A-Za-z0-9+/=\s]+['\`];",
        f"const LOGO_B64 = '{clean_b64}';",
        html, count=1
    )
    if new_html == html:
        print("ERROR: Could not replace LOGO_B64 at all.")
        raise SystemExit(1)
    print("[4/5] Replaced LOGO_B64 value only (forEach block unchanged)")
else:
    print("[4/5] Replaced full LOGO block ✅")

with open(TARGET, 'w', encoding='utf-8') as f:
    f.write(new_html)
print(f"[4/5] Wrote {TARGET}")

print("[5/5] Committing and pushing...")
os.chdir(os.path.dirname(TARGET))
subprocess.run(['git', 'add', 'webview.html'], check=True)
subprocess.run(['git', 'commit', '-m', 'fix: clean base64 and fix logo rendering'], check=True)
subprocess.run(['git', 'push'], check=True)

print("\n✅ Done! Railway redeploys in ~60s. Logo should appear.")
