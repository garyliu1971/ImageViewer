# -*- mode: python ; coding: utf-8 -*-
#
# 图片/漫画浏览器 打包配置（PyInstaller）
# 用法：pyinstaller ImageViewer_pkg.spec --noconfirm
#
# 说明：
#   - 打包为 onedir（文件夹）形式，产物在 dist/ImageViewer/，可作为安装包内容。
#   - 内置：tkinter / Pillow / numpy / PyMuPDF（PDF 漫画）/ vlc（python 绑定，
#     播放视频仍需目标机装有 VLC 播放器）。
#   - 排除：vosk / sounddevice / sherpa-onnx / ctranslate2 / sentencepiece 等大型可选依赖
#     （实时字幕与离线翻译需要额外的大模型文件 + 原生库，程序已做优雅降级，
#       不打包这些也不影响图片/漫画/PDF/投屏等核心功能）。
#   - 附带 image-viewer.html 网页版到程序目录，方便用户顺带使用。

from PyInstaller.utils.hooks import collect_dynamic_libs
import os

# PyMuPDF 的 mupdfcpp64.dll 由 _mupdf.pyd 动态加载，需显式收集
pymupdf_binaries = collect_dynamic_libs('pymupdf')

# rar/cbr 支持：rarfile 解压需要外部解压工具，把 7-Zip 随程序一起分发，
# 目标机即使没装 7-Zip / WinRAR 也能直接读 rar 漫画。没装 7-Zip 时优雅跳过。
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
    binaries=pymupdf_binaries + sevenzip_binaries,
    datas=[
        ('image-viewer.html', '.'),
    ],
    hiddenimports=[
        # 本地模块为函数内动态 import，显式声明避免遗漏
        'dlna_cast',
        'caption_engine',
        'translation_engine',
        # PyMuPDF 相关
        'pymupdf',
        'pymupdf.mupdf',
        'pymupdf.extra',
        # rar/cbr 压缩包支持
        'rarfile',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'vosk',
        'sounddevice',
        'sherpa_onnx',
        'sherpa_onnx_core',
        'onnxruntime',
        'ctranslate2',
        'sentencepiece',
        'matplotlib',
        'pandas',
        'scipy',
        'IPython',
        'jupyter',
        'pygame',
        'PyQt5',
        'PyQt6',
        'PySide2',
        'PySide6',
        'wx',
        'pytest',
        'setuptools',
    ],
    noarchive=False,
    optimize=1,
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
    upx=False,
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
    upx=False,
    upx_exclude=[],
    name='ImageViewer',
)
