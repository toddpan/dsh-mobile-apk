#!/usr/bin/env python3
"""inject-all.py — 快照注入单 pass 合并器（Phase 2c 结构性提速，2026-09-05）。

合并原三步链（每步各自全量解压+preset9 重压缩，~743MB tar × 3 遍）为**单 pass tar 流处理**：
  ① @dsh-android 命名空间注入（原 inject-snapshot.py：profiles/{web,headless}/node_modules/@dsh-android/<pkg>/）
  ② 根级插件注入（原 inject-external-plugins.py：undo/market 等非 scoped 包，lib/skills/清单文件）
  ③ cordis.patch.yml 权威装配覆盖（原 update-snapshot-patch.py：仅 web profile，--all-profiles 展开）
压缩从 ×4 → ×1、解压从 ×4 → ×1；发布档 preset 由 DSH_INJECT_PRESET 控制（默认 9 保发布保真，
-Fast dev 循环传 1 —— 743MB tar 上 preset9≈380s / preset1≈75s / xz -T0 -6≈48s 实测，2026-09-05）。

用法：
  python inject-all.py <snapshot.tar.xz> <out.tar.xz> <authoritative.patch.yml> --dsh-android <dir>... --external <dir>... [--extra <overlay-dir>...] [--all-profiles]
字节级 tar 流替换，保留 symlink 元数据（Windows bsdtar 解包 symlink 需特权——tar 流处理不物化）。
"""
import io
import json as _json
import lzma
import os
import sys
import tarfile

PROFILES = ("web", "headless")
DSH_ANDROID_NS = "node_modules/@dsh-android/"
# 2026-09-20：dsh-prompt-enhancer 的 host/client 双面 bundle 在包根（lib/index.cjs 以
# `<pkg>/plugin-host.js` 定位、web 客户端经 webServer 拿 plugin-client.js）——根级插件注入必须带上。
EXT_INCLUDE_FILES = ("package.json", "cordis.patch.yml", "spec.json", "README.md", "README.zh-CN.md", "LICENSE",
                     "plugin-host.js", "plugin-client.js")


def parse_args(argv):
    if len(argv) < 4:
        print(__doc__)
        sys.exit(2)
    src, dst, patch_src = argv[1], argv[2], argv[3]
    dsh_dirs, ext_dirs, extra_dirs, all_profiles = [], [], [], False
    i = 4
    while i < len(argv):
        if argv[i] == "--dsh-android":
            i += 1
            while i < len(argv) and not argv[i].startswith("--"):
                dsh_dirs.append(argv[i]); i += 1
        elif argv[i] == "--external":
            i += 1
            while i < len(argv) and not argv[i].startswith("--"):
                ext_dirs.append(argv[i]); i += 1
        elif argv[i] == "--extra":
            # 2026-09-20：任意路径 overlay 注入（目录内部相对路径 = 快照内路径）。
            # 用于插件运行时目录等非 node_modules 布局（如 home/.dsh/dsh-prompt-enhancer-asr/）。
            # 命中快照已有路径则替换、否则追加；权限按内容归一化（ELF/shebang 可执行）。
            i += 1
            while i < len(argv) and not argv[i].startswith("--"):
                extra_dirs.append(argv[i]); i += 1
        elif argv[i] == "--all-profiles":
            all_profiles = True; i += 1
        else:
            print("未知参数: " + argv[i]); sys.exit(2)
    return src, dst, patch_src, dsh_dirs, ext_dirs, extra_dirs, all_profiles


def build_extra_overlay(extra_dirs):
    """overlay 相对路径 -> bytes（含 .map 之外的普通文件；权限在 push 时按内容归一化）"""
    out = {}
    for d in extra_dirs:
        d = os.path.normpath(d)
        for root, _dirs, fnames in os.walk(d):
            for fn in fnames:
                full = os.path.join(root, fn)
                rel = os.path.relpath(full, d).replace("\\", "/")
                with open(full, "rb") as f:
                    out[rel] = f.read()
    return out


def build_dsh_replacements(pkg_dirs):
    """@dsh-android 包名 -> {lib 相对路径 -> bytes} + package.json bytes"""
    out = {}
    for d in pkg_dirs:
        name = os.path.basename(os.path.normpath(d))
        files = {}
        lib = os.path.join(d, "lib")
        for root, _dirs, fnames in os.walk(lib):
            for fn in fnames:
                if fn.endswith(".map"):
                    continue
                full = os.path.join(root, fn)
                rel = os.path.relpath(full, lib).replace("\\", "/")
                with open(full, "rb") as f:
                    files["lib/" + rel] = f.read()
        with open(os.path.join(d, "package.json"), "rb") as f:
            files["package.json"] = f.read()
        out[name] = files
    return out


def build_ext_replacements(pkg_dirs):
    """根级插件：真实包名（package.json name，可 scoped）-> {rel -> bytes}"""
    out = {}
    for d in pkg_dirs:
        try:
            with open(os.path.join(d, "package.json"), "rb") as f:
                name = _json.load(f)["name"]
        except Exception:
            name = os.path.basename(os.path.normpath(d))
        files = {}
        for sub in ("lib", "skills"):
            base = os.path.join(d, sub)
            if not os.path.isdir(base):
                continue
            for root, _dirs, fnames in os.walk(base):
                for fn in fnames:
                    if fn.endswith(".map"):
                        continue
                    full = os.path.join(root, fn)
                    rel = os.path.relpath(full, d).replace("\\", "/")
                    try:
                        with open(full, "rb") as f:
                            files[rel] = f.read()
                    except OSError:
                        # 悬空符号链接等不可读项（如残留的 node_modules/.bin）——跳过不致命
                        continue
        # 自包含依赖：带 node_modules/ 的插件（如 dsh-voice/dsh-gsv-tts）把自己的依赖树
        # 一起注入，避免依赖基座快照里恰好有同名包（版本漂移即运行期炸）。
        nm = os.path.join(d, "node_modules")
        if os.path.isdir(nm):
            for root, _dirs, fnames in os.walk(nm):
                for fn in fnames:
                    if fn.endswith(".map") or fn in (".modules.yaml", ".pnpm-workspace-state-v1.json"):
                        continue
                    full = os.path.join(root, fn)
                    rel = os.path.relpath(full, d).replace("\\", "/")
                    try:
                        with open(full, "rb") as f:
                            files[rel] = f.read()
                    except OSError:
                        # 悬空符号链接（如残留的 node_modules/.bin/*）——跳过不致命
                        continue
        for fn in EXT_INCLUDE_FILES:
            full = os.path.join(d, fn)
            if os.path.isfile(full):
                with open(full, "rb") as f:
                    files[fn] = f.read()
        if files:
            out[name] = files
    return out


def match_dsh_android(name, dsh_names):
    """命中返回 (pkg, rel)；lib/*(-.map) 与 package.json 可注入。"""
    parts = name.split("/")
    if len(parts) < 8 or parts[0:2] != ["home", ".dsh"]:
        return None
    if parts[2] != "profiles" or parts[3] not in PROFILES:
        return None
    if parts[4:6] != ["node_modules", "@dsh-android"]:
        return None
    pkg = parts[6]
    if pkg not in dsh_names:
        return None
    rel = "/".join(parts[7:])
    if rel.startswith("lib/"):
        return (pkg, rel) if not rel.endswith(".map") else None
    return (pkg, rel) if rel == "package.json" else None


def match_ext(name, ext_names):
    """命中返回 (pkg, rel)：lib/*(-.map) / skills/* / 清单文件。"""
    if not name.startswith("home/.dsh/profiles/"):
        return None
    for pkg in ext_names:
        marker = f"/node_modules/{pkg}/"
        idx = name.find(marker)
        if idx < 0:
            continue
        rel = name[idx + len(marker):]
        if rel.startswith("lib/") and not rel.endswith(".map"):
            return (pkg, rel)
        if rel.startswith("skills/"):
            return (pkg, rel)
        if rel.startswith("node_modules/") and not rel.endswith(".map"):
            return (pkg, rel)
        if rel in EXT_INCLUDE_FILES:
            return (pkg, rel)
    return None


def main():
    src, dst, patch_src, dsh_dirs, ext_dirs, extra_dirs, all_profiles = parse_args(sys.argv)
    preset = int(os.environ.get("DSH_INJECT_PRESET", "9"))
    with open(patch_src, "rb") as f:
        patch_bytes = f.read()
    dsh_repl = build_dsh_replacements(dsh_dirs)
    ext_repl = build_ext_replacements(ext_dirs)
    extra_overlay = build_extra_overlay(extra_dirs)
    dsh_names = set(dsh_repl.keys())
    ext_names = set(ext_repl.keys())
    print(f"inject-all: preset={preset} | @dsh-android: {sorted(dsh_names)} | external: {sorted(ext_names)} | extra overlays: {sorted(extra_overlay) if extra_dirs else []}{' (' + str(len(extra_overlay)) + ' files)' if extra_dirs else ''}")

    with lzma.open(src, "rb") as f:
        raw = f.read()
    outbuf = io.BytesIO()
    replaced = 0
    added_files = 0
    seen_ext_rels = {}
    seen_dsh = set()
    seen_ext = set()
    seen_extra = set()
    emitted_dirs = set()

    def ensure_parent_dirs(path_name, mtime):
        """overlay 追加文件可能落在快照不存在的目录——补齐父级 DIRTYPE 条目（防解压器不建隐式目录）"""
        parts = path_name.split("/")
        for i in range(1, len(parts)):
            d = "/".join(parts[:i])
            if d not in emitted_dirs:
                ti = tarfile.TarInfo(d)
                ti.type = tarfile.DIRTYPE
                ti.mode = 0o700
                ti.mtime = mtime
                tout.addfile(ti)
                emitted_dirs.add(d)
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:*") as tin, \
            tarfile.open(fileobj=outbuf, mode="w", format=tarfile.PAX_FORMAT) as tout:

        def mode_for(data):
            # 权限归一化（0.13.3）：快照源树在 WSL 9p 挂载上恒为 0777（chmod 无效），
            # 归档权限只能在重打包时按内容判定——ELF/shebang 可执行，其余数据文件不可执行。
            # Android 侧解压器同样按内容赋权，此处让归档本身可审计、可门禁校验。
            return 0o700 if data.startswith(b'\x7fELF') or data.startswith(b'#!') else 0o600

        def push(data, name, mtime):
            newm = tarfile.TarInfo(name)
            newm.size = len(data)
            newm.mtime = mtime
            newm.mode = mode_for(data)
            tout.addfile(newm, io.BytesIO(data))

        for member in tin:
            name = member.name
            if member.isfile():
                data = None
                # --extra overlay：命中快照已有路径 → 原位替换（否则末尾追加）
                if extra_overlay and name in extra_overlay:
                    push(extra_overlay[name], name, int(member.mtime))
                    seen_extra.add(name)
                    replaced += 1
                    continue
                hit = match_dsh_android(name, dsh_names) or match_ext(name, ext_names)
                if hit is not None:
                    pkg, rel = hit
                    pool = dsh_repl if (pkg in dsh_names and DSH_ANDROID_NS in name) else ext_repl
                    data = pool[pkg].get(rel)
                    if data is not None:
                        (seen_dsh if pkg in dsh_names else seen_ext).add(pkg)
                        if pkg in ext_names:
                            seen_ext_rels.setdefault(pkg, set()).add(rel)
                        push(data, name, int(member.mtime))
                        replaced += 1
                        continue
                if name.startswith("home/.dsh/profiles/") and name.endswith("/cordis.patch.yml") \
                        and "/node_modules/" not in name:
                    prof = name.split("/")[3]
                    if prof == "web" or all_profiles:
                        push(patch_bytes, name, int(member.mtime))
                        replaced += 1
                        print("  patch replaced:", name)
                        continue
                    print("  skip (non-web profile):", name)
                if data is None:
                    # 流式复制 + 只读前 4 字节判定权限（勿整文件读进内存：51k 文件 / 743MB 白花几分钟）
                    handle = tin.extractfile(member)
                    prefix = handle.read(4) if handle is not None else b''
                    if handle is not None:
                        handle.seek(0)
                    member.mode = mode_for(prefix)
                    tout.addfile(member, handle)
                else:
                    member.mode = mode_for(data)
                    tout.addfile(member, io.BytesIO(data))
            else:
                if member.isdir():
                    member.mode = 0o700
                    emitted_dirs.add(name.rstrip("/"))
                # symlink/dir/hardlink：无内容，元数据原样复制
                tout.addfile(member)

        # 追加模式：快照内不存在的包 → 全部文件落到 web profile（目录项一并生成）
        # 可复现性（2026-09-08）：新增文件用固定 mtime（SOURCE_DATE_EPOCH 可覆写），
        # 否则同一输入的两次构建 sha256 不同 → 设备每次装机都判定「快照变了」重解压。
        now = int(os.environ.get("SOURCE_DATE_EPOCH", "1704067200"))
        for pkg in sorted(dsh_names - seen_dsh):
            base = f"home/.dsh/profiles/web/node_modules/@dsh-android/{pkg}"
            for dirpath in [base, base + "/lib"]:
                ti = tarfile.TarInfo(dirpath)
                ti.type = tarfile.DIRTYPE
                ti.mode = 0o700
                ti.mtime = now
                tout.addfile(ti)
            for rel, data in sorted(dsh_repl[pkg].items()):
                push(data, base + "/" + rel, now)
                added_files += 1
            print(f"  [add] @dsh-android/{pkg} ({len(dsh_repl[pkg])} files)")
        for pkg in sorted(ext_names):
            # 已存在的包：只补齐快照里缺失的文件（典型：包已在但 node_modules/ 不在 ——
            # 只走替换会把依赖树静默丢掉，运行期才炸 import）。全新包：全部追加。
            missing = {rel: data for rel, data in ext_repl[pkg].items()
                       if pkg not in seen_ext or rel not in seen_ext_rels.get(pkg, set())}
            if not missing:
                continue
            base = f"home/.dsh/profiles/web/node_modules/{pkg}"
            for rel, data in sorted(missing.items()):
                push(data, base + "/" + rel, now)
                added_files += 1
            print(f"  [add] {pkg} ({len(missing)} files)")

        # --extra overlay：快照里没有的路径追加（含父目录补齐）
        for rel in sorted(extra_overlay):
            if rel in seen_extra:
                continue
            ensure_parent_dirs(rel, now)
            push(extra_overlay[rel], rel, now)
            added_files += 1
        if extra_dirs:
            fresh = sum(1 for rel in extra_overlay if rel not in seen_extra)
            print(f"  [extra] overlay 替换 {len(seen_extra)} / 追加 {fresh}")

    with lzma.open(dst, "wb", preset=preset) as f:
        f.write(outbuf.getvalue())
    print(f"replaced entries: {replaced} | added files: {added_files} | preset={preset}")
    print("written:", dst, os.path.getsize(dst), "bytes")


if __name__ == "__main__":
    main()
