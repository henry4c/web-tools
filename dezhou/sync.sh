#!/bin/sh
# ---------------------------------------------------------------------
# 把根目录下的源码同步到 js/（浏览器可直接 <script> 引用的版本）
#
#   根目录  engine.js  game.js  ai.js   → CommonJS（Node 跑测试用）
#   js/     engine.js  game.js  ai.js   → 浏览器全局（index.html 引用）
#
# 改完逻辑后在本目录执行：  sh sync.sh
# 之后再刷新浏览器页面。
#
# 三个源文件现在都是“双环境”写法：
#   - 有 module.exports 时走 CommonJS
#   - 否则挂到 window 上（engine → window.Holdem，game → window.HoldemGame，
#     ai → window.HoldemAI）
# 所以这里只需要原样复制，不需要再做代码变换。
# ---------------------------------------------------------------------
set -e
cd "$(dirname "$0")"

mkdir -p js
for f in engine.js game.js ai.js; do
  if [ ! -f "$f" ]; then
    echo "缺少文件: $f" >&2
    exit 1
  fi
  cp "$f" "js/$f"
done

# 自检：每个文件都能被 Node 解析
for f in js/engine.js js/game.js js/ai.js; do
  node --check "$f" >/dev/null 2>&1 || {
    echo "语法检查失败: $f" >&2
    exit 1
  }
done

echo "已同步到 js/：engine.js game.js ai.js"
