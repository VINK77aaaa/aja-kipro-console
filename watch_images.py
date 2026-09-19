# -*- coding: utf-8 -*-
"""
实时监视图片文件夹：新图片先自动归档（备份）到桌面"调试静帧存档"文件夹，
再从归档位置导入达芬奇媒体池并追加到当前时间线末尾。

用法：双击"实时导入.bat"启动（黑色小窗口最小化在任务栏），关闭那个窗口即停止监视。

规则：
- 新图片复制完成后立刻移动到归档文件夹，监视文件夹保持干净
- 达芬奇从归档位置导入，所以清理监视文件夹永远不会造成"媒体离线"
- 启动时文件夹里已有的图片：没导入过的会补导入；已经被时间线引用的会跳过，
  等你在时间线上删掉对应片段后会自动归档清理
- 正在复制中的文件会等复制完成（大小稳定）才处理
- 达芬奇没开或没进入项目时会自动等待，图片排队，进入项目后自动补导入
- 详细日志写在同目录下的"监视日志.txt"
"""
import os
import re
import time
import traceback

# ==================== 配置区 ====================
# 默认监视本脚本所在目录下的"图片"文件夹（跟着脚本走，换电脑不用改）
# 想监视别的文件夹就改成例如：IMAGE_FOLDER = r"D:\我的截图"
IMAGE_FOLDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "图片")
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".tga", ".webp", ".dng")
STILL_SECONDS = 5        # 每张图片在时间线上的时长（秒）
POLL_INTERVAL = 2        # 每隔几秒扫一次文件夹
ARCHIVE_FOLDER = os.path.join(os.path.expanduser("~"), "Desktop", "调试静帧存档")
FUSION_DLL = r"C:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll"
# ================================================

LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "监视日志.txt")
EXTS = tuple(e.lower() for e in IMAGE_EXTS)


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
        if " - " in p:
            # 剥掉"离线 - "/"Offline - "前缀再记一份
            refs.add(os.path.normpath(p.split(" - ", 1)[1].strip()))
    return refs


def archive_files(files):
    """把文件移动到归档文件夹（重名自动加序号），返回 [(旧路径, 新路径), ...]"""
    if not files:
        return []
    os.makedirs(ARCHIVE_FOLDER, exist_ok=True)
    moved = []
    for src in files:
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
            log("归档失败 %s：%s" % (os.path.basename(src), e))
    return moved


def main():
    os.makedirs(IMAGE_FOLDER, exist_ok=True)
    log("实时导入已启动，监视文件夹：" + IMAGE_FOLDER)
    log("新图片会先归档到 %s 再导入达芬奇，监视文件夹保持干净。" % ARCHIVE_FOLDER)
    log("关闭本窗口即停止监视。")

    seen = set()      # 已处理完的图片（跳过或导入失败放弃的），防止重复处理
    sizes = {}        # 正在等大小稳定的新文件
    pending = []      # 已归档、等待导入达芬奇的文件
    deferred = set()  # 还在被时间线引用、等片段删除后自动归档的图片
    fail_count = 0
    last_wait_log = 0.0
    was_connected = False

    while True:
        try:
            now_files = list_images()

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
                resolve = get_resolve()
                project = resolve.GetProjectManager().GetCurrentProject() if resolve else None
                if project is None:
                    if time.time() - last_wait_log > 15:
                        log("等待达芬奇...有 %d 张图片待处理" % len(stable))
                        last_wait_log = time.time()
                else:
                    if not was_connected:
                        log("已连接到达芬奇，当前项目：" + project.GetName())
                        was_connected = True
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
                        moved = archive_files([f])
                        if moved:
                            log("已归档新图片：" + os.path.basename(f))
                            pending.append(moved[0][1])
                        else:
                            # 归档失败（文件被占用等），先从原位置导入，之后自动补归档
                            seen.add(f)
                            deferred.add(f)
                            pending.append(f)
                            log("归档失败，先从原位置导入：" + os.path.basename(f))

            # ---------- 2. 导入排队的图片 ----------
            if pending:
                resolve = get_resolve()
                if resolve is None:
                    if was_connected:
                        log("与达芬奇失去连接，等待它重新打开...")
                        was_connected = False
                    if time.time() - last_wait_log > 15:
                        log("等待达芬奇运行...（已有 %d 张图片排队）" % len(pending))
                        last_wait_log = time.time()
                else:
                    project = resolve.GetProjectManager().GetCurrentProject()
                    if project is None:
                        if time.time() - last_wait_log > 15:
                            log("达芬奇已连接，但还没进入项目，%d 张图片排队中..." % len(pending))
                            last_wait_log = time.time()
                    else:
                        if not was_connected:
                            log("已连接到达芬奇，当前项目：" + project.GetName())
                            was_connected = True
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

            # ---------- 3. 之前被时间线引用而跳过的图片：片段删除后自动归档 ----------
            if deferred:
                resolve = get_resolve()
                project = resolve.GetProjectManager().GetCurrentProject() if resolve else None
                if project is not None:
                    referenced = pool_referenced_paths(project)
                    ready = [f for f in deferred if os.path.normpath(f) not in referenced]
                    if ready:
                        moved = archive_files(ready)
                        for f in ready:
                            deferred.discard(f)
                            seen.discard(f)  # 归档后允许以后重新丢同名图
                        if moved:
                            log("时间线片段已删除，自动归档清理 %d 张旧图片" % len(moved))

            time.sleep(POLL_INTERVAL)
        except Exception:
            log("发生错误：\n" + traceback.format_exc())
            time.sleep(3)


if __name__ == "__main__":
    main()
