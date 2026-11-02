# -*- coding: utf-8 -*-
"""alist_manager 纯逻辑单测（不依赖真实 alist.exe）。"""

import os
import socket
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import alist_manager as am


class TestGeneratePassword(unittest.TestCase):
    def test_prefix_and_length(self):
        p = am.generate_password()
        self.assertTrue(p.startswith("iv"))
        self.assertGreaterEqual(len(p), 10)

    def test_unique(self):
        self.assertNotEqual(am.generate_password(), am.generate_password())


class TestBuildArgs(unittest.TestCase):
    def test_no_data_dir(self):
        self.assertEqual(am._build_args(["server"]), ["server"])
        self.assertEqual(am._build_args(["admin", "set", "x"]),
                         ["admin", "set", "x"])

    def test_with_data_dir(self):
        self.assertEqual(am._build_args(["server"], data_dir="/d"),
                         ["--data", "/d", "server"])
        self.assertEqual(am._build_args(["admin", "set", "x"], data_dir="/d"),
                         ["--data", "/d", "admin", "set", "x"])


class TestIsRunning(unittest.TestCase):
    def test_closed_port(self):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        self.assertFalse(am.is_running(port))

    def test_open_port(self):
        srv = socket.socket()
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        port = srv.getsockname()[1]
        try:
            self.assertTrue(am.is_running(port))
        finally:
            srv.close()


class TestFindAlist(unittest.TestCase):
    def test_none_when_absent(self):
        # 只在测试目录（无 alist.exe）里找，应返回 None
        self.assertIsNone(am.find_alist(search_dirs=[os.path.dirname(__file__)]))


if __name__ == "__main__":
    unittest.main()
