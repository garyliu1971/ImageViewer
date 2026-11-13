# -*- coding: utf-8 -*-
"""scrape.parse_video 的表驱动测试（含中文用例）。"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import scrape

# (文件名, 上层目录[近->远], kind, 首选标题, year, season, episode)
CASES = [
    ("Movie.Name.2019.1080p.BluRay.x264-GRP.mkv", [], "movie", "Movie Name", 2019, None, None),
    ("The.Matrix.1999.2160p.UHD.BluRay.x265.10bit.HDR.DTS-HD.MA.5.1-GRP.mkv", [], "movie", "The Matrix", 1999, None, None),
    ("Blade.Runner.2049.2017.1080p.WEB-DL.DD5.1.H.264-GRP.mp4", [], "movie", "Blade Runner 2049", 2017, None, None),
    ("1917.2019.1080p.BluRay.x264.mkv", [], "movie", "1917", 2019, None, None),
    ("2012.2009.720p.mkv", [], "movie", "2012", 2009, None, None),
    ("Movie Name (2019).mp4", [], "movie", "Movie Name", 2019, None, None),
    ("流浪地球 (2019).mp4", [], "movie", "流浪地球", 2019, None, None),
    ("流浪地球（2019）.mkv", [], "movie", "流浪地球", 2019, None, None),
    ("流浪地球.2019.1080p.国语中字.mkv", [], "movie", "流浪地球", 2019, None, None),
    ("流浪地球 The Wandering Earth 2019 1080p BluRay.mkv", [], "movie", "流浪地球", 2019, None, None),
    ("S01E01.mp4", ["Season 1", "Breaking Bad"], "episode", "Breaking Bad", None, 1, 1),
    ("S01E01.mp4", ["Breaking Bad (2008)"], "episode", "Breaking Bad", 2008, 1, 1),
    ("Breaking.Bad.S02E13.720p.HDTV.x264-GRP.mkv", [], "episode", "Breaking Bad", None, 2, 13),
    ("Show Name - 03 [1080p][CHS].mkv", [], "episode", "Show Name", None, None, 3),
    ("Show Name - 03v2 [1080p].mkv", [], "episode", "Show Name", None, None, 3),
    ("[字幕组] 标题 - 05 [WebRip 1080p HEVC].mkv", [], "episode", "标题", None, None, 5),
    ("[Sub] Some Anime [05][1080p][CHS].mp4", [], "episode", "Some Anime", None, None, 5),
    ("[字幕组] 进击的巨人 第二季 - 05 [1080p].mkv", [], "episode", "进击的巨人", None, 2, 5),
    ("进击的巨人 第3集.mp4", ["第二季", "进击的巨人"], "episode", "进击的巨人", None, 2, 3),
    ("第1集.mp4", ["第一季", "三体 (2023)"], "episode", "三体", 2023, 1, 1),
    ("第十二集.mp4", ["三体"], "episode", "三体", None, None, 12),
    ("E05.mkv", ["Season 2", "Some Show"], "episode", "Some Show", None, 2, 5),
    ("EP01.mkv", ["Some Show"], "episode", "Some Show", None, None, 1),
    ("Some.Show.EP12.1080p.mkv", [], "episode", "Some Show", None, None, 12),
    ("Some Show S2 - 04.mkv", [], "episode", "Some Show", None, 2, 4),
    ("Some Show Season 2 Episode 3.mkv", [], "episode", "Some Show", None, 2, 3),
    ("2x05.avi", ["Old Show"], "episode", "Old Show", None, 2, 5),
    ("Old.Show.1x03.avi", [], "episode", "Old Show", None, 1, 3),
    ("01.mp4", ["Season 3", "Some Show"], "episode", "Some Show", None, 3, 1),
    ("03.mkv", ["Show Name"], "episode", "Show Name", None, None, 3),
    ("Show.Name.2019.S01E02.1080p.WEB-DL.mkv", [], "episode", "Show Name", 2019, 1, 2),
    ("Show.Name.S01E01E02.mkv", [], "episode", "Show Name", None, 1, 1),
    ("video.mp4", ["我的电影 (2020)"], "movie", "我的电影", 2020, None, None),
    ("Specials.mkv", [], "movie", "Specials", None, None, None),
    ("1080p.mkv", ["Nice Film (2011)"], "movie", "Nice Film", 2011, None, None),
    ("[1080p] Leading Noise Film 2015.mkv", [], "movie", "Leading Noise Film", 2015, None, None),
    ("Spider-Man.No.Way.Home.2021.1080p.mkv", [], "movie", "Spider-Man No Way Home", 2021, None, None),
    ("Movie_Name_2019_1080p.mkv", [], "movie", "Movie Name", 2019, None, None),
    ("Movie-Name-2019-1080p.mkv", [], "movie", "Movie Name", 2019, None, None),
    ("Some.Movie.2019-GRP.mkv", [], "movie", "Some Movie", 2019, None, None),
    ("Dolby.Test.Film.2018.Atmos.mkv", [], "movie", "Dolby Test Film", 2018, None, None),
    ("Some.Movie.2019.1920x1080.mkv", [], "movie", "Some Movie", 2019, None, None),
    ("你好，李焕英.2021.HD1080P.国语中字.mp4", [], "movie", "你好，李焕英", 2021, None, None),
    ("01.mkv", ["进击的巨人 第二季"], "episode", "进击的巨人", None, 2, 1),
    ("01.mkv", ["进击的巨人 S01"], "episode", "进击的巨人", None, 1, 1),
    ("03.mkv", ["Show Name S02"], "episode", "Show Name", None, 2, 3),
    ("S02E04.mkv", ["Season 2", "Show Name (2010)"], "episode", "Show Name", 2010, 2, 4),
    ("04.mkv", ["第二季", "三体 (2023)"], "episode", "三体", 2023, 2, 4),
    ("04.mkv", ["Show Name Season 2"], "episode", "Show Name", None, 2, 4),
    ("Episode 05.mkv", ["Season 3", "Some Show"], "episode", "Some Show", None, 3, 5),
    # 真实案例：2026 年的新一季；年份是这一季的，不是剧的；站点水印 / 论坛标记要被剥掉
    ("流人第六季.2026.S06E01.HD1080P.AAC.H264.CHS-ENG.BT世界网.[www.btsj6.com].mp4", [], "episode", "流人", 2026, 6, 1),
    ("流人第六季.S06E01.HD1080P.AAC.H264.CHS-ENG.BT世界网.[www.btsj6.com].mp4", [], "episode", "流人", None, 6, 1),
    ("流人.S06E01.2026.1080p.WEB-DL.【高清影视之家 www.hdbtt.com】.mp4", [], "episode", "流人", 2026, 6, 1),
    ("[www.btsj6.com]流人.第六季.S06E02.1080p.mp4", [], "episode", "流人", None, 6, 2),
    ("www.gaoqing.la-流人.S06E03.2026.HD1080P.mkv", [], "episode", "流人", 2026, 6, 3),
    ("BT世界网.流人.S06E04.mp4", [], "episode", "流人", None, 6, 4),
    ("流人 S06E05 2026 [电影天堂www.dygod.net].mkv", [], "episode", "流人", 2026, 6, 5),
    ("Slow.Horses.S06E01.2026.2160p.WEB-DL.DDP5.1.Atmos.H.265-GRP.mkv", [], "episode", "Slow Horses", 2026, 6, 1),
    ("Sicario Day of the Soldado 2018 BluRay.mkv", ["Season 1"], "episode", "Sicario Day of the Soldado", 2018, 1, None),
]


class TestParseVideo(unittest.TestCase):
    def test_table(self):
        for fn, parents, kind, title, year, season, ep in CASES:
            with self.subTest(fn=fn, parents=parents):
                r = scrape.parse_video(fn, parents)
                self.assertEqual(r["kind"], kind)
                self.assertTrue(r["title_candidates"], "no candidates")
                self.assertEqual(r["title_candidates"][0], title)
                self.assertEqual(r["year"], year)
                self.assertEqual(r["season"], season)
                self.assertEqual(r["episode"], ep)

    def test_bilingual_candidates(self):
        r = scrape.parse_video("流浪地球 The Wandering Earth 2019 1080p BluRay.mkv")
        self.assertEqual(r["title_candidates"][:2], ["流浪地球", "The Wandering Earth"])

    def test_dir_title_is_fallback_candidate(self):
        r = scrape.parse_video("Movie.Name.2019.mkv", ["Movie Name (2019)"])
        self.assertEqual(r["title_candidates"], ["Movie Name"])

    def test_noise_not_in_candidates(self):
        r = scrape.parse_video("Movie.Name.2019.1080p.BluRay.x264-GRP.mkv")
        for c in r["title_candidates"]:
            for bad in ("1080", "BluRay", "x264", "GRP", "2019"):
                self.assertNotIn(bad, c)

    def test_show_dir_levels(self):
        self.assertEqual(scrape.parse_video("S01E01.mp4", ["Season 1", "Show"])["show_dir_levels"], 1)
        self.assertEqual(scrape.parse_video("S01E01.mp4", ["Show"])["show_dir_levels"], 0)
        self.assertEqual(scrape.parse_video("S01E01.mp4", [])["show_dir_levels"], -1)

    def test_season_dirs(self):
        for name, n in (("Season 2", 2), ("season02", 2), ("S03", 3), ("第二季", 2), ("第十季", 10),
                        ("Specials", 0), ("Series 4", 4)):
            self.assertEqual(scrape.season_from_dir(name), n, name)
        self.assertIsNone(scrape.season_from_dir("Breaking Bad"))

    def test_cn_to_int(self):
        for s, n in (("一", 1), ("十", 10), ("十二", 12), ("二十三", 23), ("12", 12), ("两", 2)):
            self.assertEqual(scrape.cn_to_int(s), n)
        self.assertIsNone(scrape.cn_to_int("abc"))

    def test_names_from_key_and_group(self):
        fn, ps = scrape.names_from_key("dav:host:5244/电影/三体/Season 1/S01E02.mkv")
        self.assertEqual((fn, ps), ("S01E02.mkv", ["Season 1", "三体", "电影"]))
        parsed = scrape.parse_video(fn, ps)
        self.assertEqual(scrape.group_key_for("dav:host:5244/电影/三体/Season 1/S01E02.mkv", parsed),
                         "grp:dav:host:5244/电影/三体")
        k = r"c:\media\tv\show\s01e01.mkv"
        fn, ps = scrape.names_from_key(k)
        self.assertEqual((fn, ps[0]), ("s01e01.mkv", "show"))
        self.assertEqual(scrape.group_key_for(k, scrape.parse_video(fn, ps)), r"grp:c:\media\tv\show")
        self.assertIsNone(scrape.group_key_for("/a/b/Movie.2019.mkv", scrape.parse_video("Movie.2019.mkv", ["b"])))

    def test_season_dirs_share_series_title_but_not_group(self):
        a = scrape.parse_video("01.mkv", ["进击的巨人 S01"])
        b = scrape.parse_video("01.mkv", ["进击的巨人 第二季"])
        self.assertEqual(a["title_candidates"][0], b["title_candidates"][0])
        self.assertEqual((a["season"], b["season"]), (1, 2))
        ka = scrape.group_key_for("/lib/进击的巨人 S01/01.mkv", a)
        kb = scrape.group_key_for("/lib/进击的巨人 第二季/01.mkv", b)
        self.assertNotEqual(ka, kb)                                  # 目录不同 -> 前端要按 TMDB id 合并
        k1 = scrape.group_key_for("/lib/Show/Season 1/S01E01.mkv", scrape.parse_video("S01E01.mkv", ["Season 1", "Show"]))
        k2 = scrape.group_key_for("/lib/Show/Season 2/S02E01.mkv", scrape.parse_video("S02E01.mkv", ["Season 2", "Show"]))
        self.assertEqual(k1, k2)                                     # Season N 目录天然同组

    def test_garbage_does_not_crash(self):
        for fn in ("", ".mkv", "....mkv", "[][][].mp4", "第集.mp4", "-.mkv", "a" * 500 + ".mkv", "\x00.mkv"):
            scrape.parse_video(fn, ["", "/"])


if __name__ == "__main__":
    unittest.main()
