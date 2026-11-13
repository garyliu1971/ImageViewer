# -*- coding: utf-8 -*-
"""scrape 引擎 + /api/scrape/* 端点测试（全部对假 TMDB 服务器，不联网）。"""
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import scrape
import web_backend as wb
from tests.fake_tmdb import FakeTmdb, make_png

TOKEN = "SECRET_TMDB_TOKEN_do_not_leak_9f8e7d"
DAY = 86400


class Clock:
    def __init__(self):
        self.t = 1_800_000_000.0

    def __call__(self):
        return self.t


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fake = FakeTmdb(TOKEN).start()

    @classmethod
    def tearDownClass(cls):
        cls.fake.stop()

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="iv_scrape_")
        self.clock = Clock()
        self.token = TOKEN
        self.client = scrape.TmdbClient(lambda: self.token, self.fake.api_base, self.fake.image_base,
                                        min_interval=0, sleep=lambda s: None)
        self.sc = scrape.Scraper(self.tmp, self.client, now=self.clock)
        self.fake.requests.clear()
        self.fake.image_hits = 0
        self.fake.fail_429 = self.fake.fail_500 = 0

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class TestClient(Base):
    def test_auth_and_user_agent(self):
        d = self.client.configuration()
        self.assertIn("images", d)
        path, q, auth, ua = self.fake.requests[-1]
        self.assertEqual(auth, "Bearer " + TOKEN)
        self.assertTrue(ua.startswith("ImageViewer/"))

    def test_image_request_has_no_token(self):
        self.client.get_image("w342", "/matrix_poster1.jpg")
        path, q, auth, ua = self.fake.requests[-1]
        self.assertTrue(path.startswith("/t/p/w342/"))
        self.assertIsNone(auth)

    def test_bad_token(self):
        self.token = "WRONG_TOKEN_zzz"
        with self.assertRaises(scrape.TmdbError) as cm:
            self.client.configuration()
        self.assertEqual(cm.exception.code, "bad_token")
        self.assertNotIn("WRONG_TOKEN_zzz", str(cm.exception))

    def test_no_token(self):
        self.token = ""
        with self.assertRaises(scrape.TmdbError) as cm:
            self.client.search("movie", "x", "zh-CN")
        self.assertEqual(cm.exception.code, "no_token")
        self.assertEqual(self.fake.count(), 0)

    def test_429_retry_after(self):
        sleeps = []
        c = scrape.TmdbClient(lambda: TOKEN, self.fake.api_base, self.fake.image_base,
                              min_interval=0, sleep=sleeps.append)
        self.fake.fail_429 = 2
        self.fake.retry_after = "3"
        self.assertIn("images", c.configuration())
        self.assertEqual(self.fake.count("/3/configuration"), 3)
        self.assertEqual([s for s in sleeps if s >= 1], [3.0, 3.0])

    def test_429_gives_up(self):
        self.fake.fail_429 = 99
        with self.assertRaises(scrape.TmdbError) as cm:
            self.client.configuration()
        self.assertEqual(cm.exception.code, "rate_limited")
        self.assertEqual(self.fake.count("/3/configuration"), 4)

    def test_5xx_retry(self):
        self.fake.fail_500 = 1
        self.assertIn("images", self.client.configuration())

    def test_404(self):
        with self.assertRaises(scrape.TmdbError) as cm:
            self.client.details("movie", 424242, "en-US")
        self.assertEqual(cm.exception.code, "not_found")

    def test_throttle_spaces_requests(self):
        sleeps = []
        c = scrape.TmdbClient(lambda: TOKEN, self.fake.api_base, self.fake.image_base,
                              min_interval=5.0, sleep=sleeps.append)
        c.configuration()
        c.configuration()
        self.assertTrue(any(s > 4 for s in sleeps), sleeps)

    def test_network_error_has_no_token(self):
        c = scrape.TmdbClient(lambda: TOKEN, "http://127.0.0.1:1/3", min_interval=0, sleep=lambda s: None)
        with self.assertRaises(scrape.TmdbError) as cm:
            c.configuration()
        self.assertEqual(cm.exception.code, "network")
        self.assertNotIn(TOKEN, str(cm.exception))

    def test_validate_base(self):
        ok = ["https://api.themoviedb.org/3", "https://gw.example.com/tmdb/3", "http://127.0.0.1:8080/3",
              "http://192.168.1.5/3", "http://nas/3"]
        bad = ["http://api.example.com/3", "https://user:pw@gw.example.com/3", "https://a.com/3?x=1",
               "ftp://x/3", "", "javascript:alert(1)", "https://@evil.com/3", "http://8.8.8.8/3"]
        for u in ok:
            scrape.validate_base(u, "x")
        for u in bad:
            with self.assertRaises(ValueError, msg=u):
                scrape.validate_base(u, "x")

    def test_env_override_validated(self):
        old = os.environ.get("TMDB_API_BASE")
        os.environ["TMDB_API_BASE"] = "https://u:p@evil.example/3"
        try:
            with self.assertRaises(ValueError):
                scrape.TmdbClient(lambda: TOKEN)
            os.environ["TMDB_API_BASE"] = self.fake.api_base
            self.assertEqual(scrape.TmdbClient(lambda: TOKEN).api_base, self.fake.api_base)
        finally:
            if old is None:
                os.environ.pop("TMDB_API_BASE", None)
            else:
                os.environ["TMDB_API_BASE"] = old

    def test_image_base_from_configuration(self):
        c = scrape.TmdbClient(lambda: TOKEN, self.fake.api_base, min_interval=0, sleep=lambda s: None)
        self.assertEqual(c.image_base, self.fake.image_base)

    def test_token_only_sent_to_api_base(self):
        with self.assertRaises(scrape.TmdbError):
            self.client._request("http://evil.example/3/x", "application/json")


def local_key(*parts):
    return wb._resume_key(os.path.join(os.path.abspath(os.sep), *parts))


class TestScraper(Base):
    def test_movie_bilingual(self):
        it = self.sc.match(local_key("m", "流浪地球 (2019).mp4"))
        self.assertEqual(it["status"], "matched")
        m = it["media"]
        self.assertEqual((m["title_zh"], m["title_en"], m["year"]), ("流浪地球", "The Wandering Earth", "2019"))
        self.assertIn("太阳", m["overview_zh"])
        self.assertIn("sun", m["overview_en"])
        self.assertEqual(m["genres_zh"], ["科幻"])
        self.assertEqual(m["poster_path"], "/wandering_earth1.jpg")

    def test_english_movie_scene_name(self):
        it = self.sc.match(local_key("m", "The.Matrix.1999.1080p.BluRay.x264-GRP.mkv"))
        self.assertEqual(it["media"]["tmdb_id"], 603)
        self.assertEqual(it["media"]["title_zh"], "黑客帝国")
        self.assertEqual(it["media"]["title"], "黑客帝国")      # 中文优先显示

    def test_tv_episode(self):
        it = self.sc.match(local_key("tv", "Breaking Bad (2008)", "Season 1", "S01E02.mkv"))
        self.assertEqual(it["status"], "matched")
        self.assertEqual(it["media"]["media_type"], "tv")
        self.assertEqual(it["media"]["title_zh"], "绝命毒师")
        self.assertEqual(it["episode"]["name_zh"], "猫在袋子里")
        self.assertEqual(it["episode"]["name_en"], "Cat's in the Bag...")
        self.assertEqual(it["season"]["number"], 1)
        self.assertEqual(len(it["season"]["episodes"]), 3)
        self.assertTrue(it["group_key"].startswith("grp:"))

    def test_anime_dash_episode(self):
        it = self.sc.match(local_key("a", "[字幕组] 进击的巨人 - 03 [1080p].mkv"))
        self.assertEqual(it["media"]["tmdb_id"], 1429)
        self.assertEqual(it["episode"]["name_zh"], "在绝望中")

    def test_cache_hit_no_network(self):
        k = local_key("m", "流浪地球 (2019).mp4")
        self.sc.match(k)
        n = len(self.fake.requests)
        again = self.sc.match(k)
        self.assertEqual(len(self.fake.requests), n)
        self.assertEqual(again["media"]["tmdb_id"], 535167)
        self.assertEqual(self.sc.item(k)["media"]["tmdb_id"], 535167)

    def test_series_shares_requests(self):
        self.sc.match(local_key("tv", "Breaking Bad", "S01E01.mkv"))
        n = len(self.fake.requests)
        self.sc.match(local_key("tv", "Breaking Bad", "S01E02.mkv"))
        self.assertLessEqual(len(self.fake.requests) - n, 0)       # 搜索 / 详情 / 季都命中缓存

    def test_unmatched(self):
        it = self.sc.match(local_key("m", "Zzzz Unknown Film 2001.mkv"))
        self.assertEqual(it["status"], "unmatched")
        self.assertIsNone(it["media"])

    def test_needs_review_low_confidence(self):
        it = self.sc.match(local_key("m", "Dune.mkv"))
        self.assertEqual(it["status"], "needs_review")
        self.assertTrue(it["media"])                  # 暂定结果
        self.assertGreaterEqual(len(it["alternatives"]), 2)
        self.assertNotEqual(it["source"], "pin")
        self.assertIsNone(self.sc._get_row("pins", local_key("m", "Dune.mkv")))   # 绝不自动锁定

    def test_split_season_dirs_resolve_to_same_tv_id(self):
        a = self.sc.match(local_key("lib", "进击的巨人 S01", "01.mkv"))
        b = self.sc.match(local_key("lib", "进击的巨人 第二季", "01.mkv"))
        c = self.sc.match(local_key("lib", "Breaking Bad", "Season 2", "S02E01.mkv"))
        self.assertEqual((a["media"]["tmdb_id"], b["media"]["tmdb_id"]), (1429, 1429))
        self.assertNotEqual(a["group_key"], b["group_key"])
        self.assertEqual((a["season"]["number"], b["season"]["number"]), (1, 2))
        self.assertEqual(b["episode"]["name_zh"], "野兽巨人")
        self.assertEqual(c["episode"]["name_zh"], "第二季第一集")
        # 锁定其中一个目录组，另一个仍走自动匹配（前端会对每个目录组各锁一次）
        self.sc.pin(local_key("lib", "进击的巨人 S01", "01.mkv"), "tv", 1429)
        self.assertEqual(self.sc.match(local_key("lib", "进击的巨人 S01", "02.mkv"))["status"], "pinned")
        self.assertNotEqual(self.sc.match(local_key("lib", "进击的巨人 第二季", "01.mkv"))["status"], "pinned")

    def test_short_cjk_title_never_auto_accepted_via_foreign_alias(self):
        """「夸克」（<= 2 个汉字）只能靠外语别名命中 1941 年德国片：不得自动接受（既不 matched 也不 needs_review）。"""
        for name in ("夸克.mp4", "夸克 (1941).mp4", "夸克.1941.1080p.mp4"):
            it = self.sc.match(local_key("m", name))
            self.assertEqual(it["status"], "unmatched", name)
            self.assertIsNone(it["media"], name)
            alt = [a for a in it["alternatives"] if a["tmdb_id"] == 7003]
            self.assertTrue(alt and alt[0]["weak"], name)            # 仍作为候选留给手动修正
            self.assertIsNone(self.sc._get_row("pins", local_key("m", name)))

    def test_short_cjk_title_direct_match_still_works(self):
        it = self.sc.match(local_key("m", "沙丘 (2021).mkv"))
        self.assertEqual((it["status"], it["media"]["tmdb_id"]), ("matched", 7002))
        amb = self.sc.match(local_key("m", "沙丘.mkv"))                # 同名两部：待确认，不自动锁定
        self.assertEqual(amb["status"], "needs_review")

    def test_longer_cjk_title_not_restricted(self):
        self.assertEqual(self.sc.match(local_key("m", "流浪地球.mp4"))["status"], "matched")

    def test_ignore_never_hits_tmdb_and_survives_purge(self):
        k = local_key("m", "夸克.mp4")
        n = len(self.fake.requests)
        it = self.sc.set_ignore(k, True)
        self.assertEqual((it["status"], it["source"], it["media"], it["pin_scope"]), ("ignored", "pin", None, "video"))
        for force in (False, True):
            again = self.sc.match(k, force=force)
            self.assertEqual(again["status"], "ignored")
        self.assertEqual(self.sc.item(k)["status"], "ignored")
        self.assertEqual(len(self.fake.requests), n)                # 一次 TMDB 请求都没有
        self.sc.purge(everything=True)
        self.assertEqual(self.sc.match(k)["status"], "ignored")     # purge 不清忽略（和锁定一样）
        self.assertEqual(self.sc.status()["pins"], 1)
        self.assertEqual(len(self.fake.requests), n)
        self.assertIsNone(self.sc.set_ignore(k, False))
        self.assertEqual(self.sc.match(k)["status"], "unmatched")   # 取消后恢复正常刮削

    def test_ignore_group_scope_for_series_folder(self):
        a = local_key("tv", "Intro Videos", "Season 1", "S01E01.mkv")
        b = local_key("tv", "Intro Videos", "Season 2", "S02E01.mkv")
        it = self.sc.set_ignore(a, True)
        self.assertEqual(it["pin_scope"], "group")
        n = len(self.fake.requests)
        self.assertEqual(self.sc.match(b)["status"], "ignored")     # 同一系列目录的其它季也被忽略
        self.assertEqual(len(self.fake.requests), n)

    def test_unignore_keeps_real_pin(self):
        k = local_key("m", "Matrix.mkv")
        self.sc.pin(k, "movie", 603)
        self.sc.set_ignore(k, False)                                # 没有忽略记录：不动锁定
        self.assertEqual(self.sc.match(k)["status"], "pinned")
        self.sc.set_ignore(k, True)                                 # 忽略会覆盖锁定
        self.assertEqual(self.sc.match(k)["status"], "ignored")

    def test_scan_skips_ignored(self):
        k1, k2 = local_key("m", "夸克.mp4"), local_key("m", "流浪地球 (2019).mp4")
        self.sc.set_ignore(k1, True)
        n_before = len(self.fake.requests)
        jid = self.sc.start_scan([k1])
        for _ in range(100):
            j = self.sc.job(jid)
            if j["state"] == "done":
                break
            time.sleep(0.05)
        self.assertEqual((j["ignored"], j["failed"], j["matched"]), (1, 0, 0))
        self.assertEqual(len(self.fake.requests), n_before)
        self.assertEqual(j["queue"][0]["state"], "ignored")
        self.assertEqual(self.sc.match(k2)["status"], "matched")

    LIUREN = "流人第六季.2026.S06E01.HD1080P.AAC.H264.CHS-ENG.BT世界网.[www.btsj6.com].mp4"

    def test_missing_season_degrades_to_show_level(self):
        """TMDB 还没有第 6 季（/tv/{id}/season/6 回 404）：不能整体失败，要返回剧集层面的资料 + season_missing 标记。"""
        it = self.sc.match(local_key("tv", "流人", self.LIUREN))
        self.assertEqual(it["status"], "matched")
        self.assertEqual((it["media"]["tmdb_id"], it["media"]["title_zh"], it["media"]["title_en"]), (95480, "流人", "Slow Horses"))
        self.assertTrue(it["media"]["poster_path"] and it["media"]["overview_zh"])
        self.assertEqual(it["season_missing"], 6)
        self.assertIsNone(it["season"])
        self.assertIsNone(it["episode"])
        self.assertEqual([s["season_number"] for s in it["media"]["seasons"]], [1, 2, 3, 4])      # 其它季的资料还在

    def test_existing_season_still_has_episode_data(self):
        it = self.sc.match(local_key("tv", "流人", "流人.S01E02.mkv"))
        self.assertIsNone(it["season_missing"])
        self.assertEqual(it["episode"]["name_en"], "Dogs")

    def test_404_is_negative_cached_only_briefly(self):
        k = local_key("tv", "流人", self.LIUREN)
        self.sc.match(k)
        n = self.fake.count("/3/tv/95480/season/6")
        self.assertEqual(n, 1)
        self.sc.match(k, force=True)
        self.clock.t += 1800
        self.sc.match(k, force=True)
        self.assertEqual(self.fake.count("/3/tv/95480/season/6"), 1)          # 1 小时内不重复打 TMDB
        self.clock.t += 3600
        self.sc.match(k, force=True)
        self.assertEqual(self.fake.count("/3/tv/95480/season/6"), 2)          # 过了负缓存 TTL 就重新问（新一季上线后能刷出来）
        self.assertLess(scrape.NEG_TTL, DAY)

    def test_tv_year_is_a_soft_hint_not_a_filter(self):
        """文件名里的 2026 是这一季的年份：不能当 first_air_date_year 过滤（会把 2022 年首播的真剧排除，只剩 2026 年的同名干扰项）。"""
        it = self.sc.match(local_key("tv", "流人", self.LIUREN))
        self.assertEqual(it["media"]["tmdb_id"], 95480)
        tv_searches = [r for r in self.fake.requests if r[0] == "/3/search/tv"]
        self.assertTrue(tv_searches)
        self.assertTrue(all("first_air_date_year" not in r[1] for r in tv_searches))
        # 电影仍按年份过滤
        self.sc.match(local_key("m", "Dune (2021).mkv"))
        mv = [r for r in self.fake.requests if r[0] == "/3/search/movie"]
        self.assertTrue(any(r[1].get("year") == "2021" for r in mv))

    def test_stale_pinned_id_degrades(self):
        k = local_key("m", "某电影.mkv")
        with self.sc._lock, self.sc._conn() as c:
            c.execute("INSERT OR REPLACE INTO pins VALUES(?,?,?)", (k, '{"media_type": "movie", "tmdb_id": 424242}', self.clock()))
        it = self.sc.match(k)                                  # 锁定的 id 在 TMDB 已不存在：不抛错
        self.assertEqual((it["status"], it["media"], it["tmdb_missing"]), ("pinned", None, True))

    def test_year_disambiguates(self):
        it = self.sc.match(local_key("m", "Dune (2021).mkv"))
        self.assertEqual((it["status"], it["media"]["tmdb_id"]), ("matched", 7002))

    def test_ttl_expiry_refetches_and_purge(self):
        k = local_key("m", "流浪地球 (2019).mp4")
        self.sc.match(k)
        self.clock.t += 149 * DAY
        n = len(self.fake.requests)
        self.sc.match(k)
        self.assertEqual(len(self.fake.requests), n)             # 149 天内仍有效
        self.clock.t += 2 * DAY                                   # 151 天
        self.assertIsNone(self.sc.item(k))                        # 过期：item 不返回旧数据
        self.assertEqual(self.sc.status()["cached_responses"], self.sc.status()["cached_responses"])
        r = self.sc.purge()
        self.assertGreater(r["responses"], 0)
        self.assertEqual(self.sc.status()["cached_responses"], 0)
        self.assertEqual(self.sc.status()["matches"], 0)
        self.sc.match(k)
        self.assertGreater(len(self.fake.requests), n)            # 重新联网

    def test_ttl_under_six_months(self):
        self.assertLess(scrape.TTL_SECONDS, 183 * DAY)

    def test_purge_all_keeps_pins(self):
        k = local_key("m", "Matrix.mkv")
        self.sc.pin(k, "movie", 603)
        self.sc.image("/matrix_poster1.jpg", "w342")
        self.sc.purge(everything=True)
        st = self.sc.status()
        self.assertEqual((st["cached_responses"], st["images"], st["pins"]), (0, 0, 1))
        self.assertEqual(self.sc.match(k)["media"]["tmdb_id"], 603)    # 锁定还在，详情重新取

    def test_pin_wins_and_survives_rescrape(self):
        k = local_key("m", "Matrix.mkv")
        auto = self.sc.match(k)
        other = 9999 if auto["media"]["tmdb_id"] == 603 else 603
        it = self.sc.pin(k, "movie", other)
        self.assertEqual((it["status"], it["source"]), ("pinned", "pin"))
        for force in (False, True):
            again = self.sc.match(k, force=force)
            self.assertEqual(again["media"]["tmdb_id"], other)
            self.assertEqual(again["status"], "pinned")
        self.assertIsNone(self.sc.pin(k, "movie", None))              # 取消锁定
        self.assertNotEqual(self.sc.match(k, force=True)["status"], "pinned")

    def test_group_pin_applies_to_siblings(self):
        a = local_key("tv", "Some Weird Name", "Season 1", "S01E01.mkv")
        b = local_key("tv", "Some Weird Name", "Season 2", "S02E01.mkv")
        self.assertEqual(self.sc.match(a)["status"], "unmatched")
        it = self.sc.pin(a, "tv", 1396)
        self.assertEqual(it["media"]["title_zh"], "绝命毒师")
        itb = self.sc.match(b)
        self.assertEqual((itb["status"], itb["media"]["tmdb_id"]), ("pinned", 1396))
        self.assertEqual(itb["episode"]["name_zh"], "第二季第一集")

    def test_pin_validation(self):
        k = local_key("m", "x.mkv")
        for mt, tid in (("book", 1), ("movie", "603"), ("movie", True), ("movie", -1), ("movie", 10 ** 12)):
            with self.assertRaises(ValueError, msg=(mt, tid)):
                self.sc.pin(k, mt, tid)
        with self.assertRaises(scrape.TmdbError):
            self.sc.pin(k, "movie", 424242)                         # TMDB 没有：不落盘
        self.assertEqual(self.sc.status()["pins"], 0)

    def test_image_cache_and_expiry(self):
        d = self.sc.image("/matrix_poster1.jpg", "w342")
        self.assertEqual(d, make_png("matrix_poster1.jpg"))
        self.sc.image("/matrix_poster1.jpg", "w342")
        self.assertEqual(self.fake.image_hits, 1)
        self.sc.image("/matrix_poster1.jpg", "w500")                  # 另一个尺寸另存
        self.assertEqual(self.fake.image_hits, 2)
        self.assertEqual(self.sc.status()["images"], 2)
        p = os.path.join(self.sc.img_dir, "w342")
        f = os.path.join(p, os.listdir(p)[0])
        old = time.time() - 200 * DAY
        os.utime(f, (old, old))
        self.clock.t = time.time()
        self.sc.image("/matrix_poster1.jpg", "w342")
        self.assertEqual(self.fake.image_hits, 3)

    def test_image_rejects_bad_input(self):
        for p in ("/../x.jpg", "http://evil.example/x.jpg", "//evil.example/x.jpg", "/a/b.jpg", "x.jpg",
                  "/x.jpg?y=1", "/ok_path1.gif", "", "/a.jpg\\..\\b"):
            with self.assertRaises(ValueError, msg=p):
                self.sc.image(p, "w342")
        with self.assertRaises(ValueError):
            self.sc.image("/matrix_poster1.jpg", "w9999")
        with self.assertRaises(ValueError):
            self.sc.image("/matrix_poster1.jpg", "../../etc")
        self.assertEqual(self.fake.image_hits, 0)

    def test_scan_job_queue(self):
        keys = [local_key("m", "流浪地球 (2019).mp4"), local_key("m", "Dune.mkv"),
                local_key("m", "Zzzz Unknown Film 2001.mkv")]
        jid = self.sc.start_scan(keys)
        for _ in range(100):
            j = self.sc.job(jid)
            if j["state"] == "done":
                break
            time.sleep(0.05)
        self.assertEqual(j["state"], "done")
        self.assertEqual((j["matched"], j["needs_review"], j["unmatched"], j["failed"]), (1, 1, 1, 0))
        self.assertEqual([q["state"] for q in j["queue"]], ["matched", "needs_review", "unmatched"])

    def test_scan_stops_on_bad_token(self):
        self.token = "BAD"
        jid = self.sc.start_scan([local_key("m", "a%d (2019).mp4" % i) for i in range(5)])
        for _ in range(100):
            j = self.sc.job(jid)
            if j["state"] == "done":
                break
            time.sleep(0.05)
        self.assertEqual(j["failed"], 1)
        self.assertNotIn("BAD", j["last_error"])


def http(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


class TestEndpoints(Base):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.httpd, cls.thread, cls.url = wb.serve(0, open_browser=False)
        cls.base = cls.url.rstrip("/")

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        super().tearDownClass()

    def setUp(self):
        super().setUp()
        self.cfg = os.path.join(self.tmp, "cfg.json")
        wb._scrape["s"] = self.sc
        self._old_cfg = wb.CONFIG_PATH
        wb.CONFIG_PATH = self.cfg
        self.t = wb.Handler.token
        self._old_env = os.environ.get("TMDB_TOKEN")
        self.vid = os.path.join(os.path.abspath(os.sep), "movies", "流浪地球 (2019).mp4")

    def tearDown(self):
        wb._scrape.pop("s", None)
        wb.CONFIG_PATH = self._old_cfg
        super().tearDown()

    def u(self, route, **kw):
        kw["t"] = self.t
        return self.base + route + "?" + urllib.parse.urlencode(kw)

    def post(self, route, body):
        return http("POST", self.u(route), body)

    def test_requires_token(self):
        for m, r in (("GET", "/api/scrape/status"), ("POST", "/api/scrape/match"), ("POST", "/api/scrape/pin"),
                     ("POST", "/api/scrape/purge"), ("GET", "/api/scrape/image"), ("GET", "/api/scrape/item")):
            st, _, _ = http(m, self.base + r, {} if m == "POST" else None)
            self.assertEqual(st, 403, r)

    def test_status_never_returns_token(self):
        st, _, b = http("GET", self.u("/api/scrape/status"))
        j = json.loads(b)
        self.assertEqual(st, 200)
        self.assertIs(j["token_configured"], True)
        self.assertNotIn(TOKEN, b.decode())
        self.token = ""
        j = json.loads(http("GET", self.u("/api/scrape/status"))[2])
        self.assertIs(j["token_configured"], False)

    def test_match_item_pin_flow(self):
        st, _, b = self.post("/api/scrape/match", {"path": self.vid})
        j = json.loads(b)
        self.assertEqual((st, j["ok"], j["item"]["media"]["title_zh"]), (200, True, "流浪地球"))
        st, _, b = http("GET", self.u("/api/scrape/item", path=self.vid))
        self.assertEqual(json.loads(b)["item"]["media"]["title_en"], "The Wandering Earth")
        st, _, b = self.post("/api/scrape/pin", {"path": self.vid, "media_type": "movie", "tmdb_id": 603})
        self.assertEqual(json.loads(b)["item"]["status"], "pinned")
        st, _, b = self.post("/api/scrape/match", {"path": self.vid, "force": True})
        self.assertEqual(json.loads(b)["item"]["media"]["tmdb_id"], 603)

    def test_item_without_match_is_null(self):
        st, _, b = http("GET", self.u("/api/scrape/item", path=self.vid))
        self.assertEqual((st, json.loads(b)["item"]), (200, None))
        self.assertEqual(self.fake.count(), 0)

    def test_input_validation(self):
        for body in ({}, {"path": "/etc/passwd"}, {"path": "/a/b.txt"}, {"path": "/a/b.mp4\x00.png"},
                     {"path": "x" * 5000 + ".mp4"}, {"path": 5}):
            st, _, b = self.post("/api/scrape/match", body)
            self.assertEqual(st, 400, body)
        st, _, _ = self.post("/api/scrape/pin", {"path": self.vid, "media_type": "movie", "tmdb_id": "1; drop"})
        self.assertEqual(st, 400)
        st, _, _ = self.post("/api/scrape/scan", {"items": []})
        self.assertEqual(st, 400)
        self.assertEqual(self.fake.count(), 0)

    def test_remote_key(self):
        st, _, b = self.post("/api/scrape/match", {"remote": "/dav/电影/The.Matrix.1999.1080p.mkv"})
        self.assertEqual(st, 400)                                  # 没配置 WebDAV：明确报错
        wb.remote_save_config("http://nas:5244/dav", "u", "pw")    # 写的是临时配置文件
        st, _, b = self.post("/api/scrape/match", {"remote": "/dav/电影/The.Matrix.1999.1080p.mkv"})
        j = json.loads(b)
        self.assertEqual((st, j["item"]["key"]), (200, "dav:nas:5244/dav/电影/The.Matrix.1999.1080p.mkv"))
        self.assertEqual(j["item"]["media"]["tmdb_id"], 603)
        self.assertNotIn("pw", b.decode())
        self.assertEqual(self.post("/api/scrape/match", {"remote": "/dav/a/../../x.txt"})[0], 400)

    def test_image_endpoint(self):
        st, h, b = http("GET", self.u("/api/scrape/image", p="/matrix_poster1.jpg", size="w342"))
        self.assertEqual((st, b), (200, make_png("matrix_poster1.jpg")))
        self.assertTrue(h["Content-Type"].startswith("image/png"))
        for p in ("http://evil.example/a.jpg", "/../a.jpg", "/a/b.jpg"):
            st, _, _ = http("GET", self.u("/api/scrape/image", p=p, size="w342"))
            self.assertEqual(st, 400, p)
        st, _, _ = http("GET", self.u("/api/scrape/image", p="/matrix_poster1.jpg", size="w1"))
        self.assertEqual(st, 400)

    def test_purge_endpoint(self):
        self.post("/api/scrape/match", {"path": self.vid})
        st, _, b = self.post("/api/scrape/purge", {"all": True})
        self.assertGreater(json.loads(b)["removed"]["responses"], 0)

    def test_scan_endpoint_and_job(self):
        st, _, b = self.post("/api/scrape/scan", {"items": [{"path": self.vid}, {"path": self.vid}]})
        j = json.loads(b)["job"]
        self.assertEqual(j["total"], 1)                    # 去重
        for _ in range(100):
            st, _, b = http("GET", self.u("/api/scrape/job", id=j["id"]))
            if json.loads(b)["job"]["state"] == "done":
                break
            time.sleep(0.05)
        self.assertEqual(json.loads(b)["job"]["matched"], 1)
        st, _, _ = http("GET", self.u("/api/scrape/job", id="nope"))
        self.assertEqual(st, 404)

    def test_no_token_configured_errors(self):
        self.token = ""
        st, _, b = self.post("/api/scrape/match", {"path": self.vid})
        self.assertEqual((st, json.loads(b)["code"]), (503, "no_token"))
        st, _, b = self.post("/api/scrape/scan", {"items": [{"path": self.vid}]})
        self.assertEqual(st, 503)

    def test_search_endpoint(self):
        st, _, b = http("GET", self.u("/api/scrape/search", q="dune", year="2021", type="movie"))
        r = json.loads(b)["results"]
        self.assertEqual((st, [x["tmdb_id"] for x in r]), (200, [7002]))
        self.assertEqual(r[0]["title_zh"], "沙丘")
        for kw in ({"q": ""}, {"q": "x" * 200}, {"q": "a", "type": "book"}, {"q": "a", "year": "abc"}, {"q": "a", "year": "99999"}):
            self.assertEqual(http("GET", self.u("/api/scrape/search", **kw))[0], 400, kw)

    def test_peek_is_offline_and_brief(self):
        n = len(self.fake.requests)
        st, _, b = self.post("/api/scrape/peek", {"items": [{"path": self.vid}, {"path": "/x/y.txt"}]})
        j = json.loads(b)
        self.assertEqual(len(self.fake.requests), n)                 # 完全不联网
        self.assertIsNone(j["items"][0]["item"])
        self.assertEqual(j["items"][0]["parsed"]["title_candidates"][0], "流浪地球")
        self.assertIn("error", j["items"][1])
        self.post("/api/scrape/match", {"path": self.vid})
        wb.video_resume_save(self.vid, 90000, 600000)
        j = json.loads(self.post("/api/scrape/peek", {"items": [{"path": self.vid}]})[2])
        it = j["items"][0]
        self.assertEqual((it["item"]["media"]["title_zh"], it["resume_ms"]), ("流浪地球", 90000))
        self.assertNotIn("episodes", json.dumps(it["item"]))
        self.assertTrue(j["token_configured"])

    def test_peek_expired_details_do_not_fetch(self):
        self.post("/api/scrape/match", {"path": self.vid})
        self.sc.purge(True)
        # matches 表被清空 -> item None；再造一条仅详情过期的情形
        self.post("/api/scrape/match", {"path": self.vid})
        self.clock.t += 151 * DAY
        n = len(self.fake.requests)
        j = json.loads(self.post("/api/scrape/peek", {"items": [{"path": self.vid}]})[2])
        self.assertIsNone(j["items"][0]["item"])
        self.assertEqual(len(self.fake.requests), n)

    def test_cancel_endpoint(self):
        st, _, b = self.post("/api/scrape/scan", {"items": [{"path": self.vid}]})
        jid = json.loads(b)["job"]["id"]
        self.assertEqual(self.post("/api/scrape/cancel", {"id": jid})[0], 200)
        for _ in range(100):                                          # 等后台线程收尾，免得它的请求串进后面的用例
            if json.loads(http("GET", self.u("/api/scrape/job", id=jid))[2])["job"]["state"] == "done":
                break
            time.sleep(0.05)

    def test_pin_scope_reported(self):
        ep = os.path.join(os.path.abspath(os.sep), "tv", "Weird Show", "S01E01.mkv")
        it = json.loads(self.post("/api/scrape/pin", {"path": ep, "media_type": "tv", "tmdb_id": 1396})[2])["item"]
        self.assertEqual((it["status"], it["pin_scope"]), ("pinned", "group"))
        j = json.loads(self.post("/api/scrape/peek", {"items": [{"path": ep}]})[2])
        self.assertEqual(j["items"][0]["item"]["pin_scope"], "group")

    def test_ignore_endpoint_and_peek(self):
        v = os.path.join(os.path.abspath(os.sep), "movies", "夸克.mp4")
        n = len(self.fake.requests)
        st, _, b = self.post("/api/scrape/pin", {"path": v, "ignore": True})
        self.assertEqual((st, json.loads(b)["item"]["status"]), (200, "ignored"))
        j = json.loads(self.post("/api/scrape/peek", {"items": [{"path": v}]})[2])
        self.assertEqual(j["items"][0]["item"]["status"], "ignored")
        self.assertEqual(self.post("/api/scrape/match", {"path": v})[0], 200)
        self.assertEqual(self.fake.requests[n:], [])
        self.assertEqual(self.post("/api/scrape/pin", {"path": v, "ignore": "yes"})[0], 400)
        st, _, b = self.post("/api/scrape/pin", {"path": v, "ignore": False})
        self.assertEqual(st, 200)
        j = json.loads(self.post("/api/scrape/peek", {"items": [{"path": v}]})[2])
        self.assertIsNone(j["items"][0]["item"])

    def test_token_never_leaks_anywhere(self):
        """用错令牌 / 429 / 网络失败各走一遍，所有响应体、响应头、stdout/stderr 里都不能出现令牌。"""
        seen = []
        out, err = io.StringIO(), io.StringIO()
        os.environ["IV_BACKEND_VERBOSE"] = "1"
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                def grab(res):
                    seen.append(res[2].decode("utf-8", "replace"))
                    seen.append(json.dumps(res[1]))
                grab(http("GET", self.u("/api/scrape/status")))
                grab(self.post("/api/scrape/match", {"path": self.vid}))
                grab(http("GET", self.u("/api/scrape/item", path=self.vid)))
                self.token = "OTHER_BAD_TOKEN_qq"                # 令牌失效
                self.sc.purge(True)
                grab(self.post("/api/scrape/match", {"path": self.vid}))
                self.token = TOKEN
                self.fake.fail_429 = 99
                grab(self.post("/api/scrape/match", {"path": self.vid, "force": True}))
                self.fake.fail_429 = 0
                self.client.api_base = "http://127.0.0.1:1/3"      # 连不上
                grab(self.post("/api/scrape/match", {"path": os.path.join(os.sep, "n", "other (2001).mp4")}))
                grab(http("GET", self.u("/api/scrape/image", p="/matrix_poster1.jpg", size="w342")))
                grab(http("GET", self.u("/api/ping")))
                grab(http("GET", self.u("/api/progress")))
        finally:
            os.environ.pop("IV_BACKEND_VERBOSE", None)
        blob = "\n".join(seen) + out.getvalue() + err.getvalue()
        for t in (TOKEN, "OTHER_BAD_TOKEN_qq"):
            self.assertNotIn(t, blob)
        self.assertNotIn("Bearer", blob)

    def test_token_not_persisted_to_disk(self):
        self.post("/api/scrape/match", {"path": self.vid})
        for root, _d, files in os.walk(self.tmp):
            for f in files:
                with open(os.path.join(root, f), "rb") as fh:
                    self.assertNotIn(TOKEN.encode(), fh.read(), f)


if __name__ == "__main__":
    unittest.main()
