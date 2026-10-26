# -*- coding: utf-8 -*-
"""薄壳：实现见 wf_beat_core（拆分以绕开 Chaquopy 17 的 pyc 增量缓存缺陷：
源文件内容变更后同文件名的 .pyc 不会重编，改文件名强制全量编译）。"""
from wf_beat_core import *  # noqa: F401,F403
from wf_beat_core import analyze_file, SR  # 显式再导出
