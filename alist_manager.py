# -*- coding: utf-8 -*-
"""AList 进程管理（无 UI 依赖，便于单测）。

约定（AList v3.x）：
  - 服务端口 5244，WebDAV 位于 /dav，账号/密码与网页端一致
  - v3.25+ 用 `alist admin set <密码>` 设置管理员密码；v3.9+ 起需先停止服务再执行
  - 数据目录用根级 --data 标志指定（放在子命令之前）
"""

import os
import secrets
import socket
import subprocess
import sys
import time

ALIST_PORT = 5244
WEBDAV_URL = "http://127.0.0.1:%d/dav" % ALIST_PORT
WEB_URL = "http://127.0.0.1:%d" % ALIST_PORT


def generate_password(bits=48):
    """生成随机管理员密码（小写十六进制，好读好记）。"""
    return "iv" + secrets.token_hex(bits // 8)


def find_alist(extra_dirs=None, search_dirs=None):
    """查找 alist 可执行文件，返回路径或 None。

    search_dirs 给定时只在这些目录里找（用于测试，不搜 PATH）；
    否则用默认候选目录 + PATH。
    """
    names = ["alist.exe", "alist"]
    if search_dirs is not None:
        dirs = list(search_dirs)
    else:
        dirs = list(extra_dirs or [])
        if getattr(sys, "frozen", False):
            dirs.append(os.path.dirname(sys.executable))
        else:
            dirs.append(os.path.dirname(os.path.abspath(__file__)))
        dirs.append(os.getcwd())
    for d in dirs:
        for n in names:
            p = os.path.join(d, n)
            if os.path.isfile(p):
                return p
    if search_dirs is not None:
        return None
    # PATH 里找
    for n in names:
        for d in os.environ.get("PATH", "").split(os.pathsep):
            p = os.path.join(d, n) if d else ""
            if p and os.path.isfile(p):
                return p
    return None


def is_running(port=ALIST_PORT):
    """判断端口是否已被监听（AList 是否在运行）。"""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1.0):
            return True
    except OSError:
        return False


def _build_args(subcommand, data_dir=None):
    """构造 alist 命令行参数（--data 放在子命令之前）。"""
    args = []
    if data_dir:
        args += ["--data", data_dir]
    args += subcommand
    return args


def _run(exe, subcommand, data_dir=None, cwd=None, timeout=120):
    """运行 alist 子命令（隐藏窗口），返回 (code, stdout, stderr)。"""
    cmd = [exe] + _build_args(subcommand, data_dir)
    kwargs = {"stdout": subprocess.PIPE, "stderr": subprocess.PIPE}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    if cwd:
        kwargs["cwd"] = cwd
    try:
        p = subprocess.run(cmd, timeout=timeout, **kwargs)
        return (p.returncode,
                p.stdout.decode("utf-8", "replace"),
                p.stderr.decode("utf-8", "replace"))
    except subprocess.TimeoutExpired:
        return -1, "", "timeout"
    except OSError as e:
        return -1, "", str(e)


def set_admin_password(exe, password, data_dir=None, cwd=None):
    """设置管理员密码（v3.25+：alist admin set <pw>；需先停服务）。"""
    code, _out, _err = _run(exe, ["admin", "set", password],
                            data_dir=data_dir, cwd=cwd)
    return code == 0


def start_alist(exe, data_dir=None, cwd=None):
    """后台启动 alist server（隐藏窗口），返回 Popen。"""
    cmd = [exe] + _build_args(["server"], data_dir)
    kwargs = {}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    if cwd:
        kwargs["cwd"] = cwd
    return subprocess.Popen(cmd, **kwargs)


def wait_ready(port=ALIST_PORT, timeout=25):
    """轮询直到端口就绪，返回是否成功。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if is_running(port):
            return True
        time.sleep(0.3)
    return is_running(port)


def stop_alist(proc):
    """停止 AList 进程（terminate → 超时后 kill）。"""
    if proc is None:
        return
    try:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except Exception:
                pass
    except Exception:
        pass
