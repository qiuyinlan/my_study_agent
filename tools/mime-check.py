import mimetypes
import sys

print("python", sys.version.split()[0])
for ext in [".js", ".mjs", ".css", ".html", ".json"]:
    print("%-6s -> %s" % (ext, mimetypes.guess_type("x" + ext)[0]))

# ES module 加载要求 JS MIME 类型，否则浏览器拒绝执行
JS_TYPES = {"text/javascript", "application/javascript", "application/ecmascript", "text/ecmascript"}
mj = mimetypes.guess_type("x.mjs")[0]
print()
print("mjs 可以作为 ES module 加载？", "是" if mj in JS_TYPES else "否 —— 会导致模块加载失败")
