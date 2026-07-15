#!/bin/bash
# Скачивает все изображения проектов из Notion в portfolio/assets/<slug>/NN.<ext>
cd "$(dirname "$0")"
SPACE="d1a8e5bf-7270-4239-9589-9a8711265cb6"
declare -A COUNTER
ok=0; fail=0

while IFS='|' read -r slug type a name b; do
  [ -z "$slug" ] && continue
  COUNTER[$slug]=$(( ${COUNTER[$slug]:-0} + 1 ))
  idx=$(printf "%02d" ${COUNTER[$slug]})
  mkdir -p "assets/$slug"

  if [ "$type" = "gif" ]; then
    url="$a"; ext="gif"
  else
    ext="${name##*.}"
    case "$type" in
      att) url="https://erenburg.notion.site/image/attachment%3A${a}%3A${name}?table=block&id=${b}&spaceId=${SPACE}&width=1600&userId=&cache=v2&imgBuildSrc=requestProxiedImageUrl" ;;
      s3)  url="https://erenburg.notion.site/image/https%3A%2F%2Fs3-us-west-2.amazonaws.com%2Fsecure.notion-static.com%2F${a}%2F${name}?table=block&id=${b}&spaceId=${SPACE}&width=1600&userId=&cache=v2&imgBuildSrc=requestProxiedImageUrl" ;;
      pf)  url="https://erenburg.notion.site/image/https%3A%2F%2Fprod-files-secure.s3.us-west-2.amazonaws.com%2F${SPACE}%2F${a}%2F${name}?table=block&id=${b}&spaceId=${SPACE}&width=1600&userId=&cache=v2&imgBuildSrc=requestProxiedImageUrl" ;;
    esac
  fi

  out="assets/$slug/$idx.$ext"
  if [ -s "$out" ]; then ok=$((ok+1)); continue; fi
  code=$(curl -sL -w "%{http_code}" -o "$out" --max-time 60 "$url")
  size=$(stat -f%z "$out" 2>/dev/null || echo 0)
  if [ "$code" = "200" ] && [ "$size" -gt 5000 ]; then
    ok=$((ok+1))
  else
    fail=$((fail+1)); echo "FAIL [$code, ${size}b] $slug/$idx.$ext"
    rm -f "$out"
  fi
done < manifest.txt

echo "---"
echo "OK: $ok  FAIL: $fail"
du -sh assets 2>/dev/null
