#!/usr/bin/env python3
"""
Run this in ~/Documents/kai-miniapp:
  python3 fix_webview.py

It reads webview.html, applies two targeted fixes, and writes webview.html back.
Then it shows you the git diff so you can verify before pushing.
"""
import sys, os, shutil, subprocess
from datetime import datetime

TARGET = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'webview.html')

if not os.path.exists(TARGET):
    print(f"ERROR: {TARGET} not found. Run this script from ~/Documents/kai-miniapp")
    sys.exit(1)

# Backup
backup = TARGET + '.bak_' + datetime.now().strftime('%Y%m%d_%H%M%S')
shutil.copy2(TARGET, backup)
print(f"[1/4] Backup created → {backup}")

with open(TARGET, 'r', encoding='utf-8') as f:
    html = f.read()

original_len = len(html)

# ─────────────────────────────────────────────────────────────────────────────
# FIX 1: voice_mode listener is opened but never closed.
# The pattern is:
#   es.addEventListener('voice_mode', e => {
#   <blank line>
#   // Driving mode and mode status updates
#   es.addEventListener('status', e => {
#
# We need to close the voice_mode listener before the comment line.
# ─────────────────────────────────────────────────────────────────────────────

FIX1_OLD = "  es.addEventListener('voice_mode', e => {\n\n  // Driving mode and mode status updates"
FIX1_NEW = (
    "  es.addEventListener('voice_mode', e => {\n"
    "    // voice mode changes are handled client-side via cycleVoiceMode()\n"
    "  });\n"
    "\n"
    "  // Driving mode and mode status updates"
)

if FIX1_OLD in html:
    html = html.replace(FIX1_OLD, FIX1_NEW, 1)
    print("[2/4] FIX 1 applied  → voice_mode listener closed ✅")
else:
    print("[2/4] FIX 1 NOT FOUND — checking raw pattern...")
    idx = html.find("es.addEventListener('voice_mode'")
    if idx >= 0:
        print(f"      Found at index {idx}. Context:")
        print("      " + repr(html[idx:idx+120]))
    else:
        print("      voice_mode listener not found at all — already fixed or different format?")

# ─────────────────────────────────────────────────────────────────────────────
# FIX 2: status listener is missing its closing });
# The status listener block ends, then immediately the incoming_call listener
# starts — but there's no }); between them.
# ─────────────────────────────────────────────────────────────────────────────

FIX2_OLD = "  es.addEventListener('incoming_call', e => {"
FIX2_NEW = (
    "  }); // end status listener\n"
    "\n"
    "  es.addEventListener('incoming_call', e => {"
)

count = html.count(FIX2_OLD)
if count == 1:
    html = html.replace(FIX2_OLD, FIX2_NEW, 1)
    print("[3/4] FIX 2 applied  → status listener closing }); added ✅")
elif count == 0:
    print("[3/4] FIX 2 NOT FOUND — incoming_call pattern missing?")
    print("      This may already be fixed.")
else:
    print(f"[3/4] WARNING: found {count} occurrences of incoming_call — skipping to be safe")

# Write back
with open(TARGET, 'w', encoding='utf-8') as f:
    f.write(html)

new_len = len(html)
print(f"[4/4] Wrote {TARGET}  ({original_len} → {new_len} bytes, +{new_len - original_len})")

# Show diff
print("\n" + "─"*60)
print("GIT DIFF (verify before pushing):")
print("─"*60)
try:
    result = subprocess.run(['git', 'diff', 'webview.html'], capture_output=True, text=True,
                            cwd=os.path.dirname(TARGET))
    if result.stdout:
        print(result.stdout[:3000])
    else:
        print("(no diff — fixes may already have been applied)")
except Exception as e:
    print(f"git diff failed: {e}")

print("\n─"*60)
print("If the diff looks correct, run:")
print('  git add webview.html')
print('  git commit -m "fix: close voice_mode and status SSE event listeners"')
print('  git push')
print("─"*60)
