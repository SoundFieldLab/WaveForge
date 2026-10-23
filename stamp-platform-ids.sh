#!/bin/bash
cd /d/opencode/WaveForge/.tmp-oped
while pgrep -f "collect-platform-ids.mjs" > /dev/null 2>&1; do sleep 60; done
echo "collection done: $(node -e "console.log(Object.keys(require('./platform-ids.json')).length)") songs"
node stamp-platform-ids.mjs
