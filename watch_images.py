# -*- coding: utf-8 -*-
"""
实时监视图片文件夹：新图片先自动归档（备份）到桌面"调试静帧存档"文件夹，
再从归档位置导入达芬奇媒体池并追加到当前时间线末尾。

用法：双击"实时导入.bat"启动（黑色小窗口最小化在任务栏），关闭那个窗口即停止监视。

规则：
- 新图片复制完成后立刻移动到归档文件夹，监视文件夹保持干净
- 达芬奇从归档位置导入，所以清理监视文件夹永远不会造成"媒体离线"
- 时间线上自动导入的图片超过 MAX_TIMELINE_ITEMS（默认 16）张时，
  自动删除最旧的，只保留最近 16 张（图片文件仍保留在归档文件夹里不丢）
- 启动时文件夹里已有的图片：没导入过的会补导入；已经被时间线引用的会跳过，
  等你在时间线上删掉对应片段后会自动归档清理
- 正在复制中的文件会等复制完成（大小稳定）才处理
- 达芬奇没开或没进入项目时会自动等待，图片排队，进入项目后自动补导入
- 单实例保护：重复启动会自动退出（占用本机回环端口 8322 当锁）
- 每轮写心跳到同目录 .watcher-status.json，供 AJA 中文控制台的「健康状态」区读取
- 详细日志写在同目录下的"监视日志.txt"
"""
import json
import os
import re
import socket
import time
import traceback

# ==================== 配置区 ====================
# 默认监视本脚本所在目录下的"图片"文件夹（跟着脚本走，换电脑不用改）
# 想监视别的文件夹就改成例如：IMAGE_FOLDER = r"D:\我的截图"
IMAGE_FOLDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "图片")
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".tga", ".webp", ".dng")
STILL_SECONDS = 5        # 每张图片在时间线上的时长（秒）
POLL_INTERVAL = 2        # 每隔几秒扫一次文件夹
MAX_TIMELINE_ITEMS = 16  # 时间线上最多保留多少张自动导入的图片，超过自动删最旧的（0 = 不限制）
ARCHIVE_FOLDER = os.path.join(os.path.expanduser("~"), "Desktop", "调试静帧存档")
FUSION_DLL = r"C:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll"
SINGLE_INSTANCE_PORT = 8322  # 单实例锁用的本机端口（重复启动第二个监视器会自动退出）
# ================================================

LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "监视日志.txt")
# 心跳状态文件：供中文控制台的「健康状态」区读取（只写状态，不参与业务）
STATUS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".watcher-status.json")
EXTS = tuple(e.lower() for e in IMAGE_EXTS)

_WATCH_NORM = os.path.normcase(os.path.normpath(IMAGE_FOLDER)) + os.sep
_ARCHIVE_NORM = os.path.normcase(os.path.normpath(ARCHIVE_FOLDER)) + os.sep


def log(msg):
    line = time.strftime("[%m-%d %H:%M:%S] ") + msg
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def natural_key(path):
    """自然排序：img2 排在 img10 前面"""
    name = os.path.basename(path)
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


def frames_to_tc(n, fps):
    s, f = divmod(int(n), int(fps))
    m, s = divmod(s, 60)
    h, m = divmod(m, 60)
    return "%02d:%02d:%02d:%02d" % (h, m, s, f)


_lib = None


def get_resolve():
    """连接到达芬奇；达芬奇没在运行就返回 None"""
    global _lib
    try:
        if _lib is None:
            import importlib.machinery
            import importlib.util
            loader = importlib.machinery.ExtensionFileLoader("fusionscript", FUSION_DLL)
            spec = importlib.util.spec_from_loader("fusionscript", loader, origin=FUSION_DLL)
            _lib = importlib.util.module_from_spec(spec)
            loader.exec_module(_lib)
        return _lib.scriptapp("Resolve")
    except Exception:
        pass
    # 旧版达芬奇（17/18）回退方式：ctypes 直接调 scriptapp 导出函数
    try:
        import ctypes
        lib = ctypes.CDLL(FUSION_DLL)
        lib.scriptapp.restype = ctypes.py_object
        lib.scriptapp.argtypes = [ctypes.c_char_p]
        return lib.scriptapp(b"Resolve")
    except Exception:
        return None


def list_images():
    if not os.path.isdir(IMAGE_FOLDER):
        return []
    try:
        return [os.path.join(IMAGE_FOLDER, f) for f in os.listdir(IMAGE_FOLDER)
                if f.lower().endswith(EXTS)]
    except OSError:
        return []


def import_files(resolve, project, files):
    """导入媒体池并追加到时间线；结束后把页面切回用户原来所在的位置"""
    page = None
    try:
        page = resolve.GetCurrentPage()
    except Exception:
        page = None
    try:
        media_pool = project.GetMediaPool()
        clips = media_pool.ImportMedia(files)
        if not clips:
            return 0, "导入媒体池失败"
        fps = project.GetSetting("timelineFrameRate") or 25
        try:
            fps = float(fps)
        except (TypeError, ValueError):
            fps = 25.0
        if STILL_SECONDS and STILL_SECONDS > 0:
            tc = frames_to_tc(round(STILL_SECONDS * fps), fps)
            for c in clips:
                try:
                    c.SetClipProperty("Duration", tc)
                except Exception:
                    pass  # 个别情况改不了时长就用达芬奇默认，不影响导入
        timeline = project.GetCurrentTimeline()
        if timeline is None:
            media_pool.CreateTimelineFromClips("图片时间线", clips)
            where = "新建时间线「图片时间线」"
        else:
            media_pool.AppendToTimeline(clips)
            where = "时间线「%s」末尾" % timeline.GetName()
        return len(clips), where
    finally:
        try:
            if page and resolve.GetCurrentPage() != page:
                resolve.OpenPage(page)
        except Exception:
            pass


def iter_pool_clips(folder):
    """递归遍历媒体池所有文件夹里的片段"""
    clips = list(folder.GetClipList() or [])
    for sub in (folder.GetSubFolderList() or []):
        clips.extend(iter_pool_clips(sub))
    return clips


def clip_file_path(clip):
    """取片段的源文件路径；离线片段拿到的路径带"离线 - "之类前缀"""
    try:
        path = clip.GetClipProperty("File Path") or ""
    except Exception:
        path = ""
    return path


def is_our_still(media_item):
    """判断媒体池片段是否是本脚本导入的图片（源文件在监视或归档文件夹里）"""
    if not media_item:
        return False
    p = clip_file_path(media_item)
    if not p:
        return False
    if " - " in p:  # 离线片段的路径带"离线 - "/"Offline - "前缀，剥掉再判断
        p = p.split(" - ", 1)[1]
    np_ = os.path.normcase(os.path.normpath(p.strip()))
    return np_.startswith(_WATCH_NORM) or np_.startswith(_ARCHIVE_NORM)


def pool_referenced_paths(project):
    """媒体池里所有片段当前引用的源文件路径集合（含离线片段记录的原路径）"""
    refs = set()
    try:
        clips = iter_pool_clips(project.GetMediaPool().GetRootFolder())
    except Exception:
        return refs
    for c in clips:
        p = clip_file_path(c)
        if not p:
            continue
        refs.add(os.path.normpath(p.strip()))
        if " - " in p:  # 剥掉"离线 - "/"Offline - "前缀再记一份
            refs.add(os.path.normpath(p.split(" - ", 1)[1].strip()))
    return refs


def archive_files(files):
    """把文件移动到归档文件夹（重名自动加序号）。

    返回 (moved, failures)：
      moved    = [(旧路径, 新路径), ...]  成功归档的
      failures = [(旧路径, 原因), ...]    未归档的（含"文件已不存在"与"被占用"两类）
    注意：失败原因必须由调用方区分——"文件已不存在"不能拿去导入，否则会白跑重试。
    """
    if not files:
        return [], []
    try:
        os.makedirs(ARCHIVE_FOLDER, exist_ok=True)
    except OSError as e:
        return [], [(f, "无法创建归档文件夹：%s" % e) for f in files]
    moved = []
    failures = []
    for src in files:
        if not os.path.exists(src):
            failures.append((src, "文件已不存在"))
            continue
        dest = os.path.join(ARCHIVE_FOLDER, os.path.basename(src))
        try:
            if os.path.exists(dest):
                base, ext = os.path.splitext(os.path.basename(src))
                i = 1
                while os.path.exists(dest):
                    dest = os.path.join(ARCHIVE_FOLDER, "%s(%d)%s" % (base, i, ext))
                    i += 1
            os.replace(src, dest)
            moved.append((src, dest))
        except OSError as e:
            failures.append((src, str(e)))
    return moved, failures


def write_status(connected, project_name, pending_n, deferred_n, seen_n, started_ts):
    """写心跳状态文件（原子写），供中文控制台健康页读取。失败不影响主流程。"""
    data = {
        "pid": os.getpid(),
        "started_at": int(started_ts),
        "last_beat": int(time.time()),
        "watching": IMAGE_FOLDER,
        "archive": ARCHIVE_FOLDER,
        "max_timeline": MAX_TIMELINE_ITEMS,
        "poll_interval": POLL_INTERVAL,
        "connected": bool(connected),
        "project": project_name or "",
        "pending": int(pending_n),
        "deferred": int(deferred_n),
        "processed": int(seen_n),
    }
    try:
        tmp = STATUS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, STATUS_FILE)
    except Exception:
        pass


def timeline_stills(timeline):
    """取时间线上所有"本脚本导入的图片"片段，按时间线位置从旧到新排序"""
    try:
        items = list(timeline.GetItemListInTrack("video", 1) or [])
    except Exception:
        return []
    ours = []
    for it in items:
        try:
            mi = it.GetMediaPoolItem()
        except Exception:
            mi = None
        if is_our_still(mi):
            ours.append((it, mi))
    ours.sort(key=lambda t: (t[0].GetStart() or 0, t[0].GetEnd() or 0))
    return ours


def trim_timeline(project, timeline):
    """时间线上自动导入的图片超过上限时，从最旧的开始删除，
    并把已无任何引用的媒体池片段一并清掉（图片文件仍保留在归档文件夹）。
    返回 (删除的时间线片段数, 清理的媒体池片段数)"""
    if not MAX_TIMELINE_ITEMS or MAX_TIMELINE_ITEMS <= 0:
        return 0, 0
    ours = timeline_stills(timeline)
    if len(ours) <= MAX_TIMELINE_ITEMS:
        return 0, 0
    to_remove = ours[:len(ours) - MAX_TIMELINE_ITEMS]
    removed_pool = [mi for _it, mi in to_remove]
    if not timeline.DeleteClips([it for it, _mi in to_remove]):
        log("时间线清理失败：删除旧片段未成功")
        return 0, 0
    cleaned = 0
    try:
        used = set()
        for i in range(0, (project.GetTimelineCount() or 0) + 2):
            t = project.GetTimelineByIndex(i)
            if not t:
                continue
            for tr in range(1, (t.GetTrackCount("video") or 0) + 1):
                for it in (t.GetItemListInTrack("video", tr) or []):
                    try:
                        mi = it.GetMediaPoolItem()
                        if mi:
                            used.add(mi.GetMediaId())
                    except Exception:
                        pass
        dead = [mi for mi in removed_pool if mi.GetMediaId() not in used]
        if dead and project.GetMediaPool().DeleteClips(dead):
            cleaned = len(dead)
    except Exception as e:
        log("媒体池清理出错：" + str(e))
    return len(to_remove), cleaned


def main():
    # 单实例保护：占用本机回环端口当锁。端口随进程释放，不会留下"僵尸锁"。
    lock = None
    try:
        lock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        lock.bind(("127.0.0.1", SINGLE_INSTANCE_PORT))
        lock.listen(1)
    except OSError:
        try:
            if lock:
                lock.close()
        except Exception:
            pass
        log("已有监视器在运行（端口 %d 被占用），本实例直接退出。" % SINGLE_INSTANCE_PORT)
        return

    os.makedirs(IMAGE_FOLDER, exist_ok=True)
    log("实时导入已启动，监视文件夹：" + IMAGE_FOLDER)
    log("新图片会先归档到 %s 再导入达芬奇，监视文件夹保持干净。" % ARCHIVE_FOLDER)
    if MAX_TIMELINE_ITEMS > 0:
        log("时间线上最多保留 %d 张自动导入的图片，超出会自动删最旧的（文件仍留在归档文件夹）。"
            % MAX_TIMELINE_ITEMS)
    log("关闭本窗口即停止监视。")

    started_ts = time.time()
    seen = set()        # 已处理完的图片（跳过或导入失败放弃的），防止重复处理
    sizes = {}          # 正在等大小稳定的新文件
    pending = []        # 已归档、等待导入达芬奇的文件
    deferred = set()    # 还在被时间线引用、等片段删除后自动归档的图片
    archive_retry = {}  # 归档重试计数（文件被占用时用，避免刷日志/无限重试）
    fail_count = 0
    last_wait_log = 0.0
    was_connected = False

    while True:
        project_name = ""
        connected = False
        sleep_for = POLL_INTERVAL
        try:
            now_files = list_images()

            # ---------- 连接达芬奇 ----------
            resolve = get_resolve()
            project = resolve.GetProjectManager().GetCurrentProject() if resolve else None
            connected = project is not None
            if connected:
                try:
                    project_name = project.GetName()
                except Exception:
                    project_name = ""

            if project is not None and not was_connected:
                log("已连接到达芬奇，当前项目：" + project.GetName())
                was_connected = True
            if project is None and was_connected:
                log("与达芬奇失去连接，等待它重新打开...")
                was_connected = False

            # ---------- 1. 扫描新图片：复制完成就归档并排队导入 ----------
            stable = []
            for f in now_files:
                if f in seen or f in pending or f in deferred:
                    continue
                try:
                    size = os.path.getsize(f)
                except OSError:
                    continue
                if size > 0 and sizes.get(f) == size:
                    stable.append(f)
                else:
                    sizes[f] = size

            if stable:
                if project is None:
                    if time.time() - last_wait_log > 15:
                        log("等待达芬奇...有 %d 张图片待处理" % len(stable))
                        last_wait_log = time.time()
                else:
                    referenced = pool_referenced_paths(project)
                    for f in stable:
                        sizes.pop(f, None)
                        if os.path.normpath(f) in referenced:
                            # 已经导入过（旧版脚本导入的），不能移动文件否则媒体离线
                            seen.add(f)
                            deferred.add(f)
                            log("跳过已导入过的图片：%s（时间线片段删除后会自动归档）"
                                % os.path.basename(f))
                            continue
                        moved, failed = archive_files([f])
                        if moved:
                            log("已归档新图片：" + os.path.basename(f))
                            pending.append(moved[0][1])
                            continue
                        reason = failed[0][1] if failed else "未知原因"
                        if not os.path.exists(f):
                            # 文件在扫描与归档之间被移走/删除。绝不能拿不存在的路径去导入，
                            # 否则会白跑 5 次导入重试（历史日志里的 WinError 2 就是这种情形）
                            seen.add(f)
                            log("放弃 %s：文件已不存在（%s）" % (os.path.basename(f), reason))
                            continue
                        # 文件还在（多半被别的程序占用）：先从原位置导入，之后再补归档
                        seen.add(f)
                        deferred.add(f)
                        pending.append(f)
                        log("归档失败（%s），先从原位置导入：%s" % (reason, os.path.basename(f)))

            # ---------- 2. 导入排队的图片 ----------
            if pending and project is not None:
                pending.sort(key=natural_key)
                try:
                    n, where = import_files(resolve, project, list(pending))
                except Exception as e:
                    n, where = 0, str(e)
                if n:
                    log("已自动导入 %d 张图片到%s" % (n, where))
                    pending = []
                    fail_count = 0
                else:
                    fail_count += 1
                    log("导入失败（%s），第 %d 次重试..." % (where, fail_count))
                    if fail_count >= 5:
                        log("多次失败，放弃这批图片：%s" %
                            "、".join(os.path.basename(p) for p in pending))
                        pending = []
                        fail_count = 0
            elif pending:
                if time.time() - last_wait_log > 15:
                    log("等待达芬奇运行...（已有 %d 张图片排队）" % len(pending))
                    last_wait_log = time.time()

            # ---------- 3. 被时间线引用而暂缓归档的图片：片段删除后自动归档 ----------
            if deferred and project is not None:
                referenced = pool_referenced_paths(project)
                ready = [f for f in deferred if os.path.normpath(f) not in referenced]
                if ready:
                    moved, failed = archive_files(ready)
                    for f, _dest in moved:
                        deferred.discard(f)
                        seen.discard(f)  # 归档后允许以后重新丢同名图
                        archive_retry.pop(f, None)
                    for f, reason in failed:
                        if not os.path.exists(f):
                            deferred.discard(f)
                            seen.discard(f)
                            archive_retry.pop(f, None)
                            log("放弃归档 %s：文件已不存在" % os.path.basename(f))
                            continue
                        # 文件还在（多半被占用）：留在 deferred 里下轮再试，不刷屏
                        n = archive_retry.get(f, 0) + 1
                        archive_retry[f] = n
                        if n == 1:
                            log("暂缓归档 %s：%s（会自动重试）" % (os.path.basename(f), reason))
                        elif n >= 20:
                            deferred.discard(f)
                            seen.discard(f)
                            archive_retry.pop(f, None)
                            log("多次归档失败，暂时跳过 %s（文件仍在监视文件夹，可稍后手动处理）"
                                % os.path.basename(f))
                    if moved:
                        log("时间线片段已删除，自动归档清理 %d 张旧图片" % len(moved))

            # ---------- 4. 时间线滚动清理：自动导入的图片超过上限时删最旧的 ----------
            timeline = project.GetCurrentTimeline() if project is not None else None
            if timeline is not None:
                n_del, n_pool = trim_timeline(project, timeline)
                if n_del:
                    log("时间线上图片超过 %d 张，已删除最旧的 %d 张、清理媒体池 %d 项"
                        "（图片文件仍保留在归档文件夹）" % (MAX_TIMELINE_ITEMS, n_del, n_pool))

            sleep_for = POLL_INTERVAL
        except Exception:
            log("发生错误：\n" + traceback.format_exc())
            sleep_for = 3
        # 每轮都写心跳，供中文控制台「健康状态」区读取（写失败不影响主流程）
        write_status(connected, project_name, len(pending), len(deferred), len(seen), started_ts)
        time.sleep(sleep_for)

if __name__ == "__main__":
    main()
