# -*- mode: python ; coding: utf-8 -*-

import os

# rar/cbr 支持：把 7-Zip 随程序分发（没装 7-Zip 时优雅跳过）
sevenzip_binaries = []
for _f in ("7z.exe", "7z.dll"):
    _p = os.path.join(r"C:\Program Files\7-Zip", _f)
    if os.path.isfile(_p):
        sevenzip_binaries.append((_p, "."))
    else:
        _p86 = os.path.join(r"C:\Program Files (x86)\7-Zip", _f)
        if os.path.isfile(_p86):
            sevenzip_binaries.append((_p86, "."))


a = Analysis(
    ['image_viewer.py'],
    pathex=[],
    binaries=sevenzip_binaries,
    datas=[('image-viewer.html', '.')],
    hiddenimports=['rarfile'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='ImageViewer',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['viewer.ico'],
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='ImageViewer',
)
