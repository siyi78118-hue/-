#!/bin/bash
# Mac 用户：双击本文件即可启动桥接。若提示"无法打开"，右键→打开 一次即可。
cd "$(dirname "$0")"
echo "正在启动谪仙剧本工作台桥接..."
python3 bridge.py || {
  echo
  echo "启动失败：可能没装 Python3。Mac 一般自带；若没有，请到 https://www.python.org 下载安装后重试。"
  read -n 1 -s -r -p "按任意键关闭"
}
