# -*- coding: utf-8 -*-
"""图片漫画浏览器 —— 一键打包脚本（安装包 + 便携版）

步骤：
  1. PyInstaller 打包应用（ImageViewer_pkg.spec → dist/ImageViewer）
  2. 暂存发布目录：重命名 exe 为「图片漫画浏览器.exe」+ 附 README / 使用说明
  3. ISCC 生成安装程序 发布/图片漫画浏览器_v1.0.0_安装程序.exe
  4. 生成便携版 发布/图片漫画浏览器_v1.0_便携版.zip

用法：
  python build_installer.py               # 完整一键打包
  python build_installer.py --skip-build  # 复用现有 dist/ImageViewer
"""
import os
import sys
import time
import shutil
import zipfile
import subprocess

ROOT = os.path.dirname(os.path.abspath(__file__))
VERSION = "1.0.0"
APP_NAME = "图片漫画浏览器"
EXE_SRC = "ImageViewer.exe"
EXE_DST = f"{APP_NAME}.exe"
RELEASE_DIR = os.path.join(ROOT, "发布")
STAGE_DIR = os.path.join(RELEASE_DIR, APP_NAME)

ISCC_CANDIDATES = [
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "Inno Setup 6", "ISCC.exe"),
    r"C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    r"C:\Program Files\Inno Setup 6\ISCC.exe",
]


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def run(cmd):
    log(">> " + " ".join(cmd))
    r = subprocess.run(cmd, cwd=ROOT)
    if r.returncode != 0:
        raise SystemExit(f"\n命令失败（退出码 {r.returncode}）：{' '.join(cmd)}")


def find_iscc():
    for c in ISCC_CANDIDATES:
        if c and os.path.isfile(c):
            return c
    raise SystemExit("未找到 Inno Setup 编译器 ISCC.exe，请先安装 Inno Setup 6。")


def main():
    skip_build = "--skip-build" in sys.argv
    dist = os.path.join(ROOT, "dist", "ImageViewer")
    os.makedirs(RELEASE_DIR, exist_ok=True)

    # 1. PyInstaller
    if skip_build:
        log("步骤 1/4：跳过 PyInstaller（--skip-build），复用现有 dist/ImageViewer")
    else:
        log("步骤 1/4：PyInstaller 打包应用")
        run([sys.executable, "-m", "PyInstaller", "ImageViewer_pkg.spec", "--noconfirm"])
    if not os.path.isfile(os.path.join(dist, EXE_SRC)):
        raise SystemExit(f"未找到 {dist}/{EXE_SRC}，打包失败？")

    # 2. 暂存发布目录
    log("步骤 2/4：暂存发布目录")
    if os.path.isdir(STAGE_DIR):
        shutil.rmtree(STAGE_DIR)
    shutil.copytree(dist, STAGE_DIR)
    shutil.move(os.path.join(STAGE_DIR, EXE_SRC), os.path.join(STAGE_DIR, EXE_DST))
    for doc in ("README.md", "使用说明.txt", "image-viewer.html"):
        p = os.path.join(ROOT, doc)
        if os.path.isfile(p):
            shutil.copy(p, STAGE_DIR)
    # 注入默认 AI 翻译密钥（DeepSeek），随包开箱即用（运行时配置路径为 _internal/image_viewer.json）
    default_cfg = os.path.join(ROOT, "image_viewer.default.json")
    if os.path.isfile(default_cfg):
        shutil.copy(default_cfg, os.path.join(STAGE_DIR, "_internal", "image_viewer.json"))

    # 3. Inno Setup 安装程序
    log("步骤 3/4：Inno Setup 生成安装程序")
    run([find_iscc(), "/Qp", "ImageViewer_setup.iss"])

    # 4. 便携版 zip
    log("步骤 4/4：生成便携版 zip")
    portable_zip = os.path.join(RELEASE_DIR, f"{APP_NAME}_v1.0_便携版.zip")
    if os.path.isfile(portable_zip):
        os.remove(portable_zip)
    with zipfile.ZipFile(portable_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for root, _, files in os.walk(STAGE_DIR):
            for f in files:
                full = os.path.join(root, f)
                z.write(full, os.path.relpath(full, RELEASE_DIR))
    log(f"便携版已生成：{portable_zip}")

    log("")
    log("全部完成！发布/ 目录中的文件可拷贝到 U 盘分发：")
    for f in sorted(os.listdir(RELEASE_DIR)):
        p = os.path.join(RELEASE_DIR, f)
        if os.path.isdir(p):
            log(f"  {os.path.relpath(p, ROOT):40s} （目录）")
        else:
            log(f"  {os.path.relpath(p, ROOT):40s} {os.path.getsize(p)/1e6:8.1f} MB")


if __name__ == "__main__":
    main()
