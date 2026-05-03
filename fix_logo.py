#!/usr/bin/env python3
"""
Run from inside ~/Documents/kai-miniapp:
  python3 fix_logo.py
"""
import os, shutil, subprocess
from datetime import datetime

TARGET = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'webview.html')

if not os.path.exists(TARGET):
    print(f"ERROR: {TARGET} not found. Run this from ~/Documents/kai-miniapp")
    raise SystemExit(1)

backup = TARGET + '.bak_' + datetime.now().strftime('%Y%m%d_%H%M%S')
shutil.copy2(TARGET, backup)
print(f"[1/4] Backup → {backup}")

with open(TARGET, 'r', encoding='utf-8') as f:
    html = f.read()

OLD = """['logoImg','emptyLogo','callLogo'].forEach(id => {
  const img = document.getElementById(id); if(img) img.src = 'data:image/png;base64,' + LOGO_B64;
});"""

NEW = """(function() {
  const bytes = atob(LOGO_B64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  const blob = new Blob([arr], {type: 'image/png'});
  const url = URL.createObjectURL(blob);
  ['logoImg','emptyLogo','callLogo'].forEach(id => {
    const img = document.getElementById(id); if(img) img.src = url;
  });
})();"""

if OLD in html:
    html = html.replace(OLD, NEW, 1)
    print("[2/4] FIX applied → Blob URL replaces data URI ✅")
else:
    print("[2/4] Pattern not found — checking variants...")
    # Try without leading spaces
    OLD2 = "['logoImg','emptyLogo','callLogo'].forEach(id => {\n  const img = document.getElementById(id); if(img) img.src = 'data:image/png;base64,' + LOGO_B64;\n});"
    if OLD2 in html:
        html = html.replace(OLD2, NEW, 1)
        print("[2/4] FIX applied (variant) → Blob URL replaces data URI ✅")
    else:
        # Show what's actually there around the logo assignment
        idx = html.find("LOGO_B64")
        instances = []
        start = 0
        while True:
            idx = html.find("LOGO_B64", start)
            if idx == -1:
                break
            instances.append((idx, html[max(0,idx-60):idx+80]))
            start = idx + 1
        print(f"  Found {len(instances)} LOGO_B64 references:")
        for i, (pos, ctx) in enumerate(instances):
            print(f"  [{i}] pos={pos}: {repr(ctx)}")
        print("  Please fix manually using the context above.")
        raise SystemExit(1)

with open(TARGET, 'w', encoding='utf-8') as f:
    f.write(html)
print(f"[3/4] Wrote {TARGET}")

print("[4/4] Committing and pushing...")
os.chdir(os.path.dirname(TARGET))
subprocess.run(['git', 'add', 'webview.html'], check=True)
subprocess.run(['git', 'commit', '-m', 'fix: use Blob URL for logo to fix ERR_INVALID_URL'], check=True)
subprocess.run(['git', 'push'], check=True)

print("\n✅ Done! Railway redeploys in ~60s. Logo should appear.")
