// 接入 Spotify 传统模式 PC 页面分发（一次性脚本）
const fs = require('fs');
const file = 'src/components/TraditionalView.tsx';
let s = fs.readFileSync(file, 'utf8');
const rn = '\r\n';

// 1) lazy 声明
const lazyAnchor = "const LazyApplePcSearch = lazy(() => import('../features/traditionalPc/ApplePcSearch'))";
if (!s.includes(lazyAnchor)) { console.log('lazy anchor missing'); process.exit(1); }
s = s.replace(lazyAnchor, lazyAnchor + rn + "const LazySpotifyPcHome = lazy(() => import('../features/traditionalPc/SpotifyPcHome'))");

// 2) spotify 分支（apple 分支结束后、fallback 前）
const tail = "'Apple Music')" + rn + '    }' + rn + rn + '    return <PcEmpty theme={pcTheme(pcChromeQQ.tone)} title="该平台暂未提供客户端复刻页" />' + rn + '  }';
const idx = s.indexOf(tail);
if (idx < 0) { console.log('tail missing'); process.exit(1); }
const branch = [
  "'Apple Music')" + rn + '    }',
  rn + "    if (platform === 'spotify') {",
  "      if (pageId === 'home') {",
  '        return wrap(',
  '          <LazySpotifyPcHome',
  "            tone={pcChromeApple.tone}",
  "            accent='#1ed760'",
  '            loggedIn={spotifyLoggedIn}',
  '            username={spotifyUsername}',
  '            avatar={spotifyAvatar}',
  '            actions={pcActions}',
  '            active={active}',
  '            currentSong={currentSong}',
  "            onLoginClick={() => { setLoginPlatform('spotify'); setShowLogin(true) }}",
  '          />,',
  "          'Spotify 发现页'",
  '        )',
  '      }',
  "      return wrap(<PcEmpty theme={pcTheme(pcChromeApple.tone)} title=\"该页面暂未提供\" />, 'Spotify')",
  '    }' + rn + rn + '    return <PcEmpty theme={pcTheme(pcChromeQQ.tone)} title="该平台暂未提供客户端复刻页" />' + rn + '  }',
].join(rn);
s = s.slice(0, idx) + branch + s.slice(idx + tail.length);
fs.writeFileSync(file, s);
console.log('dispatch wired');
