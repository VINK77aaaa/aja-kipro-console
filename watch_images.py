# -*- coding: utf-8 -*-
"""
实时监视图片文件夹：一有新图片，就自动导入达芬奇媒体池并追加到当前时间线末尾。

用法：双击"实时导入.bat"启动（黑色小窗口会最小化到任务栏），关闭那个窗口即停止监视。

规则：
- 只导入"监视启动之后"新放进来的图片，文件夹里原有的图片不会重复导入
- 图片正在复制中不会导入，等文件复制完成（大小稳定）后才导入
- 达芬奇没开或没进入项目时会自动等待，图片先排队，进入项目后自动补导入
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
IMPORT_EXISTING_ON_START = False  # True = 启动时把文件夹里已有的图片也导入一遍
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


def get_current_page(resolve):
    try:
        return resolve.GetCurrentPage()
    except Exception:
        return None


def restore_page(resolve, page):
    """导入操作会把界面切到剪辑页，这里把用户原本所在页面（比如调色页）切回去"""
    if not page:
        return
    try:
        if resolve.GetCurrentPage() != page:
            resolve.OpenPage(page)
    except Exception:
        pass


def import_files(resolve, project, files):
    page = get_current_page(resolve)
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
        restore_page(resolve, page)


def main():
    os.makedirs(IMAGE_FOLDER, exist_ok=True)
    log("实时导入已启动，监视文件夹：" + IMAGE_FOLDER)
    log("只导入从现在起新放进来的图片。关闭本窗口即停止监视。")

    seen = set() if IMPORT_EXISTING_ON_START else set(list_images())
    sizes = {}      # 新文件的大小记录，连续两次一致才算复制完成
    pending = []    # 复制完成、等待导入的图片
    fail_count = 0
    last_wait_log = 0.0
    was_connected = False

    while True:
        try:
            # ---------- 扫描新图片 ----------
            for f in list_images():
                if f in seen:
                    continue
                try:
                    size = os.path.getsize(f)
                except OSError:
                    continue
                if size > 0 and sizes.get(f) == size:
                    seen.add(f)
                    pending.append(f)
                    sizes.pop(f, None)
                else:
                    sizes[f] = size

            # ---------- 导入排队的图片 ----------
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

            time.sleep(POLL_INTERVAL)
        except Exception:
            log("发生错误：\n" + traceback.format_exc())
            time.sleep(3)


main()
